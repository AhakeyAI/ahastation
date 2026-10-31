"""Short-lived task guardian: owns the session lock and the entire process tree.

It survives a Bridge disconnect/crash until the configured execution timeout.
Cancellation is a local durable marker; only owned processes are cleaned up.
"""
from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from ctypes import wintypes

from session_runtime import SessionLock
from task_ownership import LinuxTaskTree, recover_linux
from task_journal import cancelled, save_result, write_json


class TaskCancelled(Exception):
    pass


def task_state(spec,status):
    if spec.get('_journal_dir'):
        write_json(Path(spec['_journal_dir'])/'status.json',{'status':status,'task_id':spec['task'].get('task_id')})
    emit({'type':'state','status':status})


def emit(value: dict) -> None:
    try:
        print(json.dumps(value, ensure_ascii=False), flush=True)
    except (BrokenPipeError, OSError):
        # Parent Bridge disappeared. Still own the lock and finish/clean up.
        pass


class WindowsJob:
    def __init__(self):
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k = k
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self.name = f"PocketVibeTask-{uuid.uuid4()}"
        self.handle = k.CreateJobObjectW(None, self.name)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        class BasicLimits(ctypes.Structure):
            _fields_ = [("per_process", ctypes.c_int64), ("per_job", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
                        ("max_ws", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ro", "wo", "oo", "rt", "wt", "ot")]
        class Limits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", IO), ("process_mem", ctypes.c_size_t),
                        ("job_mem", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
        limits = Limits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def attach_and_resume(self, proc: subprocess.Popen) -> None:
        # Membership was installed atomically by CreateProcessW's job list.
        inside = wintypes.BOOL()
        self.k.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        if not self.k.IsProcessInJob(wintypes.HANDLE(int(proc._handle)), self.handle, ctypes.byref(inside)) or not inside.value:
            raise RuntimeError("Task was not atomically created in its Job Object")
        # Popen closes its primary-thread handle. Enumerate only threads owned
        # by our suspended child and resume them after verifying job membership.
        class Thread(ctypes.Structure):
            _fields_ = [(name, wintypes.DWORD) for name in ("size", "usage", "tid", "pid")] + [
                ("base", wintypes.LONG), ("delta", wintypes.LONG), ("flags", wintypes.DWORD)]
        k = self.k
        k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k.Thread32First.argtypes = k.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(Thread)]
        k.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenThread.restype = wintypes.HANDLE
        k.ResumeThread.argtypes = [wintypes.HANDLE]
        k.ResumeThread.restype = wintypes.DWORD
        snap = k.CreateToolhelp32Snapshot(4, 0)
        resumed = False
        try:
            entry = Thread(); entry.size = ctypes.sizeof(entry)
            more = k.Thread32First(snap, ctypes.byref(entry))
            while more:
                if entry.pid == proc.pid:
                    thread = k.OpenThread(2, False, entry.tid)
                    if thread:
                        try:
                            resumed |= k.ResumeThread(thread) != 0xFFFFFFFF
                        finally:
                            k.CloseHandle(thread)
                more = k.Thread32Next(snap, ctypes.byref(entry))
        finally:
            k.CloseHandle(snap)
        if not resumed:
            raise RuntimeError("Could not resume task-owned process")

    def spawn(self, command, **kwargs):
        # Popen owns its normal pipes/handles/communicate implementation. Its
        # one CreateProcess call is replaced only inside this short-lived task
        # guardian so STARTUPINFOEX carries both handle and job lists.
        import _winapi
        original = _winapi.CreateProcess
        _winapi.CreateProcess = self._create_process
        try:
            return subprocess.Popen(command, **kwargs)
        finally:
            _winapi.CreateProcess = original

    def _create_process(self, application, command, process_attrs, thread_attrs, inherit, flags, env, cwd, source):
        class Startup(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("reserved", wintypes.LPWSTR), ("desktop", wintypes.LPWSTR),
                        ("title", wintypes.LPWSTR)] + [(name, wintypes.DWORD) for name in
                        ("x", "y", "width", "height", "chars_x", "chars_y", "fill", "flags")] + [
                        ("show", wintypes.WORD), ("reserved_size", wintypes.WORD), ("reserved_data", ctypes.c_void_p),
                        ("stdin", wintypes.HANDLE), ("stdout", wintypes.HANDLE), ("stderr", wintypes.HANDLE)]
        class StartupEx(ctypes.Structure):
            _fields_ = [("startup", Startup), ("attributes", ctypes.c_void_p)]
        class ProcessInfo(ctypes.Structure):
            _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE), ("pid", wintypes.DWORD), ("tid", wintypes.DWORD)]
        k = self.k
        k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
        k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
        k.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                    wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                    ctypes.POINTER(StartupEx), ctypes.POINTER(ProcessInfo)]
        handles = (source.lpAttributeList or {}).get("handle_list", [])
        size = ctypes.c_size_t()
        count = 2 if handles else 1
        k.InitializeProcThreadAttributeList(None, count, 0, ctypes.byref(size))
        storage = ctypes.create_string_buffer(size.value)
        if not k.InitializeProcThreadAttributeList(storage, count, 0, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            jobs = (wintypes.HANDLE * 1)(self.handle)
            # PROC_THREAD_ATTRIBUTE_JOB_LIST: no create→AssignProcess crash gap.
            if not k.UpdateProcThreadAttribute(storage, 0, 0x2000D, jobs, ctypes.sizeof(jobs), None, None):
                raise ctypes.WinError(ctypes.get_last_error())
            if handles:
                inherited = (wintypes.HANDLE * len(handles))(*handles)
                if not k.UpdateProcThreadAttribute(storage, 0, 0x20002, inherited, ctypes.sizeof(inherited), None, None):
                    raise ctypes.WinError(ctypes.get_last_error())
            startup = StartupEx()
            startup.startup.cb = ctypes.sizeof(startup)
            startup.startup.flags, startup.startup.show = source.dwFlags, source.wShowWindow
            for name, value in (("stdin", source.hStdInput), ("stdout", source.hStdOutput), ("stderr", source.hStdError)):
                setattr(startup.startup, name, int(value) if value is not None else None)
            startup.attributes = ctypes.cast(storage, ctypes.c_void_p)
            environment = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items())) + "\0\0") if env is not None else None
            info = ProcessInfo()
            if not k.CreateProcessW(application, ctypes.create_unicode_buffer(command), None, None, inherit,
                                    flags | 0x80000 | 0x400, environment, cwd, ctypes.byref(startup), ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            return int(info.process), int(info.thread), info.pid, info.tid
        finally:
            k.DeleteProcThreadAttributeList(storage)

    def empty(self) -> bool:
        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_int64) for name in ("user", "kernel", "period_user", "period_kernel")] + [
                (name, wintypes.DWORD) for name in ("faults", "total", "active", "terminated")]
        info = Accounting()
        if not self.k.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return info.active == 0

    def kill(self) -> None:
        if not self.k.TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None


def windows_identity(pid: int) -> tuple[dict | None, bool]:
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = k.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:  # PID no longer exists.
            return None, False
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        identity = {"pid": pid, "created": (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}
        waited = k.WaitForSingleObject(handle, 0)
        if waited not in (0, 258):
            raise ctypes.WinError(ctypes.get_last_error())
        return identity, waited == 258
    finally:
        k.CloseHandle(handle)


def test_checkpoint(spec: dict, stage: str, proc) -> None:
    # Fault injection is inaccessible from Hub turn fields. Only direct test
    # specs plus an explicit test-process environment flag can activate it.
    if os.getenv("POCKET_VIBE_TEST_FAULTS") == "1" and spec.get("_test_fault") == stage:
        emit({"type": "checkpoint", "stage": stage, "pid": proc.pid})
        os._exit(97)


def recover(state: dict) -> None:
    if not state or (state.get("exit_proof") is True and state.get("phase") == "cleaned" and state.get("status") == "idle"):
        return
    if state.get("status") == "idle" and not state.get("version"):
        return  # Legacy idle references have no recorded pending task.
    if sys.platform == "win32":
        atomic = state.get("version") == 2 and state.get("containment") == "windows-job-list"
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        k.OpenJobObjectW.restype = wintypes.HANDLE
        handle = k.OpenJobObjectW(0x1F003F, False, state.get("job", ""))
        if handle:
            job = WindowsJob.__new__(WindowsJob); job.k = k; job.handle = handle
            k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
            k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            k.CloseHandle.argtypes = [wintypes.HANDLE]
            try:
                job.kill()
                deadline = time.monotonic() + 10
                while not job.empty() and time.monotonic() < deadline:
                    time.sleep(0.05)
                if not job.empty():
                    raise RuntimeError("Previous task process cleanup cannot be confirmed")
            finally:
                job.close()
        elif ctypes.get_last_error() != 2:
            raise ctypes.WinError(ctypes.get_last_error())
        if not atomic:
            raise RuntimeError("Legacy staged Job creation has no complete ownership proof; recovery remains unconfirmed")
        # Job absence alone is insufficient: require our pre-creation atomic
        # containment record, a dead owner, and no still-identical live root.
        # Atomic job membership + kill-on-close means no unbound suspended
        # child can exist, even if the owner died before recording its PID.
        for key in ("owner", "root"):
            saved = state.get(key)
            if not saved:
                if key == "owner":
                    raise RuntimeError("Missing Job owner identity")
                continue
            current, alive = windows_identity(saved["pid"])
            if current == saved and alive:
                raise RuntimeError("Previous task-owned process has not exited")
    elif sys.platform.startswith("linux"):
        recover_linux(state)
    elif sys.platform == "darwin":
        from macos_task import recover_macos
        recover_macos(state)
    else:
        raise RuntimeError("No reliable whole-chain recovery mechanism on this POSIX platform")


def run(spec: dict, macos_context: dict | None = None, macos_tree=None) -> dict:
    task = spec["task"]
    provider, native_id = spec.get("provider", ""), spec.get("session_id", "")
    lock = SessionLock(provider, native_id) if provider and native_id else None
    proc = job = tree = None
    owned: dict = {}
    recovered = not lock
    result = {"ok": False, "capability": "local.agent", "cleanup_confirmed": False}
    if lock:
        task_state(spec,'waiting')
        while not lock.try_acquire():
            if cancelled(spec):
                lock.close()
                result.update(cancelled=True,cleanup_confirmed=True,error='Cancelled before execution')
                save_result(spec,result)
                return result  # Never overwrite the running predecessor's lock record.
            time.sleep(.05)
    try:
        if lock:
            owned = lock.read()
            if not (macos_context and owned.get("containment") == "macos-launch-pending"
                    and owned.get("macos_job", {}).get("label") == macos_context["label"]):
                recover(owned)
            recovered = True
        # Validate again after waiting for another Bridge's turn to finish.
        target = spec.get("remote_target")
        if target:
            from desktop_control_panel import discover_sessions
            from session_runtime import device_id
            options = task.get("turn_options", {})
            if (provider != target.get("provider") or native_id != target.get("session_id")
                or task.get("cwd") != target.get("cwd") or options.get("cwd", task.get("cwd")) != target.get("cwd")
                or options.get("mode", "resume") != "resume"):
                raise RuntimeError("Remote reference does not match task execution parameters")
            if target.get("device_id") != device_id() or not any(
                row["session_id"] == target["session_id"] and row.get("cwd") == target["cwd"]
                for row in discover_sessions(provider, strict=True)
            ):
                raise RuntimeError("Selected remote session is no longer valid on this device")
            if not Path(target["cwd"]).is_dir() or not os.access(target["cwd"], os.R_OK):
                raise RuntimeError("Selected remote project directory does not exist or cannot be accessed")
        if spec.get('project_policy') is not None:
            from project_policy import authorized_cwd
            actual=authorized_cwd(task.get('cwd') or spec.get('working_dir'),spec['project_policy'])
            task['cwd']=str(actual)
            task['turn_options']={**task.get('turn_options',{}),'cwd':str(actual)}
            spec['working_dir']=str(actual)
        if sys.platform == "win32":
            job = WindowsJob()
            owned = {"version": 2, "status": "running", "phase": "prepared",
                     "containment": "windows-job-list", "job": job.name,
                     "owner": windows_identity(os.getpid())[0]}
        elif sys.platform.startswith("linux"):
            tree = LinuxTaskTree()  # Fail before spawning on unsupported POSIX.
            owned = {"version": 2, "status": "running", "phase": "prepared",
                     "containment": "linux-subreaper", "owner": tree.owner, "tracked": []}
        elif sys.platform == "darwin":
            if macos_tree is None:
                raise RuntimeError("macOS task must run through its transient launchd guardian")
            tree = macos_tree
            owned = tree.record()
        else:
            raise RuntimeError("Unsupported task supervision platform")
        if lock:
            owned['task_id']=task.get('task_id')
            lock.write(owned)  # Durable intent before any task process exists.
        if cancelled(spec): raise TaskCancelled()
        spawn = job.spawn if job else subprocess.Popen
        proc = spawn(spec["command"], cwd=spec.get("working_dir") or None,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                                creationflags=4 if job else 0,
                                start_new_session=False)
        test_checkpoint(spec, "created", proc)
        owned.update(status="running", phase="running", pid=proc.pid)
        if job:
            owned["root"] = windows_identity(proc.pid)[0]
            if lock:
                lock.write(owned)
            test_checkpoint(spec, "recorded", proc)
            job.attach_and_resume(proc)
            test_checkpoint(spec, "bound", proc)
        else:
            owned["tracked"] = tree.snapshot()
            if lock:
                lock.write(owned)
            if sys.platform == "darwin": test_checkpoint(spec, "recorded", proc)
        task_state(spec,'running')
        deadline = time.monotonic() + spec["timeout"]
        data = json.dumps(task, ensure_ascii=False).encode()
        while True:
            if cancelled(spec): raise TaskCancelled()
            if tree:
                owned["tracked"] = tree.snapshot()
                if lock:
                    lock.write(owned)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(spec["command"], spec["timeout"])
            try:
                stdout, stderr = proc.communicate(data, timeout=min(.05, remaining))
                break
            except subprocess.TimeoutExpired:
                data = None
        out = stdout.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(out) if out.strip() else None
        except ValueError:
            parsed = None
        result.update(ok=proc.returncode == 0, exit_code=proc.returncode,
                      stdout=out[:20000], stderr=stderr.decode("utf-8", errors="replace")[:8000], json=parsed)
    except TaskCancelled:
        task_state(spec,'cancelling')
        result.update(cancelled=True,error='Cancelled by the remote owner; task cleanup required')
    except subprocess.TimeoutExpired:
        result["error"] = "Local agent timed out; task-owned process cleanup is required."
        result["timeout_seconds"] = spec["timeout"]
    except BaseException as exc:
        result["error"] = f"Local agent execution failed: {type(exc).__name__}: {exc}"
    finally:
        try:
            # Popen itself can fail after native process creation, before it
            # returns a Python object. Containment still owns that child.
            if job:
                if proc and proc.poll() is None:
                    proc.kill()
                if not job.empty():
                    job.kill()
                if proc:
                    proc.wait(timeout=10)
                deadline = time.monotonic() + 10
                while not job.empty() and time.monotonic() < deadline:
                    time.sleep(0.05)
                if not job.empty():
                    raise RuntimeError("Task process tree has not exited")
            elif tree:
                def persist(tracked):
                    owned.update(tracked=tracked, phase="cleaning")
                    if lock:
                        lock.write(owned)
                tree.cleanup(proc, persist)
                if proc:
                    proc.wait(timeout=10)
            if not recovered:
                raise RuntimeError("Previous task cleanup has not been confirmed")
            result["cleanup_confirmed"] = True
            if lock:
                lock.write({"version": 2, "status": "idle", "phase": "cleaned", "exit_proof": True,'last_task_id':task.get('task_id')})
            task_state(spec,'idle')
        except BaseException as exc:
            result.update(ok=False, cleanup_confirmed=False,
                          error=f"{result.get('error', '')} Process cleanup unconfirmed: {exc}")
            if lock:
                lock.write({**owned, "status": "cleanup-unconfirmed"})
            task_state(spec,'cleanup-unconfirmed')
        finally:
            if job:
                job.close()
            if lock:
                lock.close()
    save_result(spec,result)
    return result


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:] == ['--probe']:
        from runtime_entry import python_command
        if sys.platform=='darwin':
            from macos_task import macos_support_error
            error=macos_support_error()
            print(json.dumps({'ok':not error,'error':error})); sys.exit(1 if error else 0)
        probe=run({'task':{},'provider':'','session_id':'','command':python_command(Path(__file__).with_name('idle_probe.py'))+['--quick'], 'timeout':1})
        print(json.dumps({'ok':probe.get('cleanup_confirmed') is True})); sys.exit(0 if probe.get('cleanup_confirmed') else 1)
    if sys.platform.startswith("linux") and os.getsid(0) != os.getpid():
        os.setsid()
    spec = json.load(sys.stdin)
    if sys.platform == "darwin":
        from macos_task import enter_job, launch_task
        try:
            if len(sys.argv) == 3 and sys.argv[1] == "--macos-job":
                if os.getenv("POCKET_VIBE_TEST_FAULTS") == "1" and spec.get("_test_fault") == "macos-before-guardian-record":
                    os._exit(97)  # The durable launch reservation predates this guardian.
                context, tree = enter_job(sys.argv[2])
                result = run(spec, context, tree)
            else:
                result = launch_task(spec, emit)
        except BaseException as exc:
            result = {"ok": False, "cleanup_confirmed": False, "error": f"macOS supervision failed: {exc}"}
        emit({"type": "result", "result": result})
    else:
        emit({"type": "result", "result": run(spec)})
