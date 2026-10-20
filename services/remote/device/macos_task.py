"""Task-local launchd resource coalition; no installed/persistent agent service.

XNU counts every live Mach task in a resource coalition, independently of SID,
process group and reparenting. Enumeration is for cleanup, never exit proof.
Required native interfaces are probed before Bridge advertises execution.
"""
from __future__ import annotations

import ctypes
import errno
import json
import os
import plistlib
import shutil
import signal
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path

from session_runtime import state_dir, SessionLock


class DarwinAPI:
    def __init__(self):
        if sys.platform != "darwin":
            raise RuntimeError("Darwin native APIs require macOS")
        self.lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        self.proc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.proc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.proc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.lib.coalition_info_resource_usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
        self.proc.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        data = ctypes.create_string_buffer(128); size = ctypes.c_size_t(len(data))
        if self.lib.sysctlbyname(b"kern.bootsessionuuid", data, ctypes.byref(size), None, 0):
            raise OSError(ctypes.get_errno(), "Cannot query macOS boot identity")
        self.boot = data.value.decode()
        if not self.boot: raise RuntimeError("Missing macOS boot identity")

    def info(self, pid, flavor, size):
        data = ctypes.create_string_buffer(size)
        count = self.proc.proc_pidinfo(pid, flavor, 0, data, size)
        if count != size:
            error = ctypes.get_errno()
            if error in (errno.ESRCH, errno.ENOENT): return None
            raise OSError(error or errno.EIO, f"Cannot query process {pid}, flavor {flavor}")
        return data.raw

    def identity(self, pid):
        raw = self.info(pid, 17, 56)  # PROC_PIDUNIQIDENTIFIERINFO (API struct).
        if raw is None: return None
        unique, parent, version = struct.unpack_from("=QQi", raw, 16)
        if not unique: raise RuntimeError("Native process unique identity unavailable")
        return {"pid": pid, "unique_id": unique, "parent_unique_id": parent, "pidversion": version, "boot_id": self.boot}

    def coalition(self, pid):
        raw = self.info(pid, 20, 40)  # Resource, jetsam IDs + three reserved u64.
        return struct.unpack_from("=Q", raw)[0] if raw else None

    def alive(self, identity):
        if not same_process(self.identity(identity["pid"]), identity): return False
        raw = self.info(identity["pid"], 13, 64)  # PROC_PIDT_SHORTBSDINFO.
        return bool(raw and struct.unpack_from("=I", raw, 12)[0] != 5)  # SZOMB.

    def usage(self, coalition_id):
        # Kernel copies min(user size, current struct size). First two fields
        # are the API's tasks_started/tasks_exited; later fields can grow.
        data = ctypes.create_string_buffer(1024)
        if self.lib.coalition_info_resource_usage(coalition_id, data, len(data)):
            raise OSError(ctypes.get_errno(), "Cannot verify resource coalition task counts")
        started, exited = struct.unpack_from("=QQ", data.raw)
        if exited > started: raise RuntimeError("Invalid coalition counters")
        return started, exited

    def pids(self):
        size = self.proc.proc_listpids(1, 0, None, 0)
        if size <= 0: raise OSError(ctypes.get_errno(), "Cannot enumerate macOS processes")
        for _ in range(4):
            data = ctypes.create_string_buffer(size + 4096)
            count = self.proc.proc_listpids(1, 0, data, len(data))
            if count <= 0: raise OSError(ctypes.get_errno(), "Cannot enumerate macOS processes")
            if count < len(data): return [pid for (pid,) in struct.iter_unpack("=i", data.raw[:count]) if pid > 0]
            size = len(data) * 2
        raise RuntimeError("Process list changed too rapidly to enumerate")

    def members(self, coalition_id):
        found = []
        for pid in self.pids():
            try:
                if self.coalition(pid) != coalition_id: continue
                identity = self.identity(pid)
                if identity and self.coalition(pid) == coalition_id and same_process(self.identity(pid), identity):
                    found.append(identity)
            except OSError as exc:
                if exc.errno in (errno.ESRCH, errno.ENOENT, errno.EPERM, errno.EACCES): continue
                raise
        return found

    def kill(self, identity, coalition_id):
        current = self.identity(identity["pid"])
        if not same_process(current, identity) or self.coalition(identity["pid"]) != coalition_id: return
        # The kernel validates PID version when resolving the audit token,
        # closing the identity-check → numeric kill PID reuse race.
        token = (ctypes.c_uint32 * 8)(0, os.geteuid(), os.getegid(), os.getuid(), os.getgid(),
                                      current["pid"], 0, current["pidversion"])
        error = self.proc.proc_signal_with_audittoken(token, signal.SIGKILL)
        if error not in (0, errno.ESRCH, errno.ENOENT): raise OSError(error, "Task-owned process signal refused")


def same_process(current, saved):
    return bool(current and saved and all(current.get(key) == saved.get(key) for key in ("pid", "unique_id", "boot_id")))


def pending_alive(state, api=None):
    api = api or DarwinAPI()
    if api.alive(state["owner"]): return True
    path = Path(state["macos_job"]["folder"], "guardian.json")
    if path.exists():
        record = json.loads(path.read_text())
        return bool(record.get("owner") and api.alive(record["owner"]))
    return False


class MacTaskTree:
    def __init__(self, context):
        self.api = DarwinAPI()
        self.owner = self.api.identity(os.getpid())
        self.cid = self.api.coalition(os.getpid())
        if not self.owner or not self.cid or not context.get("parent_coalition") or self.cid == context["parent_coalition"]:
            raise RuntimeError("launchd did not isolate this task in a resource coalition")
        started, exited = self.api.usage(self.cid)
        if started - exited != 1:
            raise RuntimeError("Task coalition is not exclusive to its guardian")
        self.started = started
        self.context = context

    def record(self):
        return {"version": 2, "status": "running", "phase": "prepared", "containment": "macos-resource-coalition",
                "exclusive": True, "coalition_id": self.cid, "owner": self.owner, "started": self.started,
                "macos_job": self.context, "tracked": []}

    def snapshot(self):
        return [row for row in self.api.members(self.cid) if not same_process(row, self.owner)]

    def cleanup(self, proc, persist):
        deadline = time.monotonic() + 10
        while True:
            if proc is not None: proc.poll()
            owned = self.snapshot(); persist(owned)
            for row in owned: self.api.kill(row, self.cid)
            started, exited = self.api.usage(self.cid)
            if started < self.started: raise RuntimeError("Task coalition identity/counters changed")
            if started - exited == 1 and same_process(self.api.identity(os.getpid()), self.owner):
                return  # Kernel accounts for only this guardian, not a scan inference.
            if started - exited < 1: raise RuntimeError("Task guardian coalition invariant failed")
            if time.monotonic() >= deadline: raise RuntimeError("Task coalition still has live descendants")
            time.sleep(.02)


def recover_macos(state):
    api = DarwinAPI()
    owner = state.get("owner", {})
    if owner.get("boot_id") and owner["boot_id"] != api.boot: return
    if state.get("containment") == "macos-launch-pending":
        path = Path(state["macos_job"]["folder"], "guardian.json")
        if not path.exists(): raise RuntimeError("macOS launch outcome unconfirmed; reservation retained")
        record = json.loads(path.read_text())
        if not record.get("exclusive"): raise RuntimeError("macOS guardian isolation was not confirmed")
        if api.alive(record["owner"]): raise RuntimeError("Previous macOS guardian is still alive")
        state.update(record); owner = state["owner"]
    if (state.get("containment") != "macos-resource-coalition" or not state.get("exclusive")
        or not state.get("coalition_id") or not owner.get("boot_id")):
        raise RuntimeError("Previous macOS task has no verified coalition ownership record")
    cid = state["coalition_id"]
    current_coalition = api.coalition(os.getpid())
    if not current_coalition or cid == current_coalition: raise RuntimeError("Refusing to clean current/unverifiable coalition")
    if api.alive(owner): raise RuntimeError("Previous guardian is still alive")
    deadline = time.monotonic() + 10
    while True:
        rows = api.members(cid); state["tracked"] = rows
        for row in rows: api.kill(row, cid)
        started, exited = api.usage(cid)  # ESRCH is unconfirmed, never PID/SID absence proof.
        if started < state.get("started", 0): raise RuntimeError("Coalition identity/counters changed")
        if started == exited: return
        if time.monotonic() >= deadline: raise RuntimeError("Previous macOS task coalition exit remains unconfirmed")
        time.sleep(.02)


def launchctl(*args):
    result = subprocess.run(["/bin/launchctl", *args], capture_output=True, timeout=15)
    if result.returncode: raise RuntimeError(f"launchctl {args[0]} failed: {result.stderr.decode(errors='replace')[:500]}")


def launch_task(spec, emit, *, probe=False):
    """Proxy the existing guardian protocol through one transient launchd job.

    The inner guardian owns the same SessionLock. Losing this proxy/Bridge
    never releases that lock or abandons the inner timeout/cleanup.
    """
    api = DarwinAPI()
    token = uuid.uuid4().hex
    folder = state_dir() / "macos-tasks" / token; folder.mkdir(parents=True, mode=0o700)
    label = f"org.pocket-vibe.task.{token}"
    context = {"label": label, "service": f"user/{os.getuid()}/{label}", "folder": str(folder),
               "parent_coalition": api.coalition(os.getpid())}
    script = Path(__file__) if probe else Path(__file__).with_name("task_process.py")
    from runtime_entry import python_command
    arguments = python_command(script)+["--macos-job", str(folder / "context.json")]
    for name, content in (("input.json", spec), ("context.json", context)):
        path = folder / name; path.write_text(json.dumps(content), encoding="utf-8"); path.chmod(0o600)
    job = {"Label": label, "ProgramArguments": arguments, "RunAtLoad": True, "LaunchOnlyOnce": True,
           "ProcessType": "Interactive", "AbandonProcessGroup": False,
           "StandardInPath": str(folder / "input.json"), "StandardOutPath": str(folder / "output.jsonl"),
           "StandardErrorPath": str(folder / "error.log"), "EnvironmentVariables": dict(os.environ)}
    plist = folder / "task.plist"; plist.write_bytes(plistlib.dumps(job)); plist.chmod(0o600)
    confirmed = False; owner = None; bootstrapped = False; result = None
    lock = SessionLock(spec["provider"], spec["session_id"]) if spec.get("provider") and spec.get("session_id") else None
    if lock:
        try:
            emit({"type": "state", "status": "waiting"})
            while True:
                from task_journal import cancelled, save_result
                if cancelled(spec):
                    result={'ok':False,'cancelled':True,'cleanup_confirmed':True,'error':'Cancelled before execution'}
                    save_result(spec,result); shutil.rmtree(folder); return result
                while not lock.try_acquire():
                    if cancelled(spec):
                        result={'ok':False,'cancelled':True,'cleanup_confirmed':True,'error':'Cancelled before execution'}
                        save_result(spec,result); shutil.rmtree(folder); return result
                    time.sleep(.05)
                previous = lock.read()
                if previous.get("containment") == "macos-launch-pending" and pending_alive(previous, api):
                    # Handoff to the launchd guardian has not acquired the
                    # kernel lock yet. Keep queuing rather than rejecting or
                    # stealing its durable reservation.
                    lock.close(); time.sleep(.05)
                    lock = SessionLock(spec["provider"], spec["session_id"])
                    continue
                break
            if previous and not (previous.get("status") == "idle" and (previous.get("exit_proof") or not previous.get("version"))):
                recover_macos(previous)
            lock.write({"version": 2, "status": "waiting", "phase": "reserved", "containment": "macos-launch-pending",
                        "owner": api.identity(os.getpid()), "macos_job": context})
        except BaseException:
            shutil.rmtree(folder)  # No launchd job/child has been created yet.
            raise
        finally: lock.close()
    if os.getenv("POCKET_VIBE_TEST_FAULTS") == "1" and spec.get("_test_fault") == "macos-reserved":
        os._exit(97)  # No job/child yet; persistent reservation must not be erased.
    try:
        bootstrapped = True  # Submission failure/timeout can have an unknown outcome.
        launchctl("bootstrap", f"user/{os.getuid()}", str(plist))
        # Bounds only startup/protocol loss. Never cancel a live task on the
        # proxy's timeout; its own guardian remains responsible for cleanup.
        startup = time.monotonic() + 20
        offset = 0; dead_seen = False
        while True:
            identity_file = folder / "guardian.json"
            if owner is None and identity_file.exists(): owner = json.loads(identity_file.read_text())["owner"]
            output = folder / "output.jsonl"
            if output.exists():
                with output.open("rb") as stream:
                    stream.seek(offset)
                    while True:
                        before = stream.tell(); line = stream.readline()
                        if not line.endswith(b"\n"): stream.seek(before); break
                        frame = json.loads(line)
                        if frame.get("type") == "result": result = frame["result"]
                        elif frame.get("type") == "probe": result = frame; confirmed = True
                        else: emit(frame)
                    offset = stream.tell()
            alive = owner and api.alive(owner)
            if owner and not alive:
                if result is None and not dead_seen:
                    dead_seen = True
                    continue  # Drain frames flushed between the last read and exit.
                if result is None: raise RuntimeError("macOS guardian exited without cleanup proof; recovery required")
                confirmed = result.get("cleanup_confirmed", confirmed)
                return result
            if owner is None and time.monotonic() > startup: raise RuntimeError("macOS guardian did not start; launchd job retained")
            time.sleep(.02)
    finally:
        # Do not bootout a possibly live guardian on proxy failure/cancellation.
        if probe or confirmed or (owner and not api.alive(owner)) or not bootstrapped:
            if bootstrapped:
                try: launchctl("bootout", context["service"])
                except RuntimeError: pass  # LaunchOnlyOnce may already be unloaded.
            if probe or confirmed or not bootstrapped: shutil.rmtree(folder)


_support = None


def macos_support_error():
    global _support
    if _support is None:
        try:
            launch_task({}, lambda _: None, probe=True)
            _support = ""
        except Exception as exc:
            _support = f"macOS 执行能力不可用：{type(exc).__name__}: {exc}"
    return _support


def enter_job(path):
    context = json.loads(Path(path).read_text())
    target = Path(context["folder"], "guardian.json")
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"owner": DarwinAPI().identity(os.getpid()), "exclusive": False}))
    os.replace(temporary, target)
    tree = MacTaskTree(context)
    temporary.write_text(json.dumps(tree.record())); os.replace(temporary, target)
    return context, tree


if __name__ == "__main__":
    context, tree = enter_job(sys.argv[2])
    # Probe the native identity-aware signal syscall against a task-owned
    # test child via the real guardian framework, not a simulated platform.
    from runtime_entry import python_command
    proc = subprocess.Popen(python_command(Path(__file__).with_name('idle_probe.py')), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tree.cleanup(proc, lambda _: None); proc.wait(timeout=10)
    print(json.dumps({"type": "probe", "cleanup_confirmed": True}), flush=True)
