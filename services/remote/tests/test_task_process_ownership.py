"""Native Windows/Linux process regressions; stdlib only, no CLI/model calls."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

DEVICE = Path(__file__).resolve().parents[1] / "device"
sys.path.insert(0, str(DEVICE))
import task_process
from task_ownership import linux_identity, kill_identity, descendants, LinuxTaskTree
from session_runtime import SessionLock, execution_status


class OwnershipTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pocket-ownership-")
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"POCKET_VIBE_STATE_DIR": str(self.root / "state"), "POCKET_VIBE_TEST_FAULTS": "1"})
        self.env.start(); self.processes = []; self.owned = []
        if sys.platform.startswith("linux"):
            LinuxTaskTree()  # Test harness adopts and reaps deliberate crash orphans.

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None: proc.kill()
            proc.wait(timeout=10)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream: stream.close()
        if sys.platform.startswith("linux"):
            self.owned.extend(descendants(linux_identity(os.getpid())))
            for identity in self.owned: kill_identity(identity)
            for identity in self.owned:
                deadline = time.monotonic() + 3
                while linux_identity(identity["pid"]) == identity and time.monotonic() < deadline:
                    try: os.waitpid(identity["pid"], os.WNOHANG)
                    except ChildProcessError: pass
                    time.sleep(.02)
                self.assertNotEqual(linux_identity(identity["pid"]), identity, "Test-owned process remains")
        self.env.stop(); self.temp.cleanup()

    def spawn(self, code, timeout=5, fault=None):
        spec = {"task": {}, "command": [sys.executable, "-c", code], "timeout": timeout,
                "working_dir": str(self.root), "provider": "codex", "session_id": "native", "_test_fault": fault}
        proc = subprocess.Popen([sys.executable, "-u", str(DEVICE / "task_process.py")], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.processes.append(proc); proc.stdin.write(json.dumps(spec)); proc.stdin.close()
        return proc

    def wait_for(self, condition):
        deadline = time.monotonic() + 8
        while not condition():
            if time.monotonic() > deadline: self.fail("Timed out waiting for test process")
            time.sleep(.01)

    def running(self, proc):
        while line := proc.stdout.readline():
            frame = json.loads(line)
            if frame.get("status") == "running": return
        self.fail(proc.stderr.read())

    def finish(self, proc):
        frames = [json.loads(line) for line in proc.stdout]
        proc.wait(timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stderr.read())
        return next(frame["result"] for frame in frames if frame["type"] == "result")

    def detached_code(self):
        marker, pidfile = self.root / "late-write", self.root / "child.json"
        child = (f"import sys,os,json,time; sys.path.insert(0,{str(DEVICE)!r}); "
                 "from task_ownership import linux_identity; from pathlib import Path; "
                 f"Path({str(pidfile)!r}).write_text(json.dumps(linux_identity(os.getpid()))); "
                 f"time.sleep(1.5); Path({str(marker)!r}).write_text('escaped'); time.sleep(30)")
        launch = f"import sys,subprocess,time; subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        return launch, marker, pidfile

    @unittest.skipUnless(sys.platform.startswith("linux"), "Requires native Linux subreaper/pidfd")
    def test_timeout_cleans_setsid_descendant_before_next_native_turn(self):
        launch, marker, pidfile = self.detached_code()
        first = self.spawn(launch + "time.sleep(30)", timeout=.5); self.running(first)
        self.wait_for(pidfile.exists); identity = json.loads(pidfile.read_text()); self.owned.append(identity)
        started = self.root / "next.json"
        code = (f"import sys,json; sys.path.insert(0,{str(DEVICE)!r}); from task_ownership import linux_identity; from pathlib import Path; "
                f"Path({str(started)!r}).write_text(json.dumps({{'previous_alive':linux_identity({identity['pid']})=={identity!r}}}))")
        second = self.spawn(code)
        self.assertEqual(json.loads(second.stdout.readline())["status"], "waiting")
        self.assertFalse(started.exists())
        self.assertTrue(self.finish(first)["cleanup_confirmed"])
        self.assertTrue(self.finish(second)["ok"])
        self.assertFalse(json.loads(started.read_text())["previous_alive"])
        time.sleep(1.6); self.assertFalse(marker.exists())
        self.assertEqual(execution_status("codex", "native"), "idle")

    @unittest.skipUnless(sys.platform.startswith("linux"), "Requires native Linux subreaper/pidfd")
    def test_parent_exits_before_detached_double_fork_is_cleaned(self):
        launch, marker, pidfile = self.detached_code()
        # An intermediate process exits immediately after its setsid child is
        # born; the adapter also exits, before the child's delayed write.
        intermediate = launch + "sys.exit(0)"
        root = f"import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c',{intermediate!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        root += f"\nwhile not Path({str(pidfile)!r}).exists(): time.sleep(.01)\nprint('{{}}')"
        first = self.spawn(root); self.running(first)
        self.wait_for(pidfile.exists); self.owned.append(json.loads(pidfile.read_text()))
        result = self.finish(first); self.assertTrue(result["ok"]); self.assertTrue(result["cleanup_confirmed"])
        time.sleep(1.6); self.assertFalse(marker.exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Requires native Linux subreaper/pidfd")
    def test_subreaper_crash_blocks_new_task_even_when_original_session_is_empty(self):
        launch, marker, pidfile = self.detached_code()
        first = self.spawn(launch + "time.sleep(30)"); self.running(first)
        self.wait_for(pidfile.exists); identity = json.loads(pidfile.read_text()); self.owned.append(identity)
        lock = SessionLock("codex", "native")
        self.wait_for(lambda: identity in lock.read().get("tracked", []))
        self.owned.extend(lock.read()["tracked"]); lock.close()
        first.kill(); first.wait()
        next_file = self.root / "should-not-run"
        second = self.spawn(f"from pathlib import Path; Path({str(next_file)!r}).touch()")
        result = self.finish(second)
        self.assertFalse(result["cleanup_confirmed"]); self.assertFalse(next_file.exists())
        self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")
        time.sleep(1.6); self.assertFalse(marker.exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Requires native Linux subreaper/pidfd")
    def test_pid_identity_mismatch_never_kills_other_process(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.processes.append(other)
        identity = linux_identity(other.pid); self.owned.append(identity)
        kill_identity({**identity, "start_ticks": identity["start_ticks"] + 1})
        self.assertIsNone(other.poll())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Requires native Linux subreaper/pidfd")
    def test_crash_before_child_metadata_keeps_session_quarantined(self):
        first = self.spawn("import time; time.sleep(30)", fault="created")
        frames = [json.loads(line) for line in first.stdout]; first.wait(timeout=10)
        self.assertEqual(first.returncode, 97)
        pid = next(frame["pid"] for frame in frames if frame["type"] == "checkpoint")
        identity = linux_identity(pid)
        if identity: self.owned.append(identity)
        lock = SessionLock("codex", "native"); state = lock.read(); lock.close()
        self.assertEqual(state["phase"], "prepared"); self.assertEqual(state["tracked"], [])
        marker = self.root / "should-not-start"
        result = self.finish(self.spawn(f"from pathlib import Path; Path({str(marker)!r}).touch()"))
        self.assertFalse(result["cleanup_confirmed"]); self.assertFalse(marker.exists())
        self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")

    @unittest.skipUnless(os.name == "nt", "Requires native Windows Job Objects")
    def test_atomic_job_covers_creation_metadata_and_binding_crash_points(self):
        for stage in ("created", "recorded", "bound"):
            with self.subTest(stage=stage):
                first = self.spawn("import time; time.sleep(30)", fault=stage)
                frames = [json.loads(line) for line in first.stdout]; first.wait(timeout=10)
                self.assertEqual(first.returncode, 97)
                pid = next(frame["pid"] for frame in frames if frame["type"] == "checkpoint")
                self.wait_for(lambda: not task_process.windows_identity(pid)[1])
                lock = SessionLock("codex", "native"); state = lock.read(); lock.close()
                self.assertEqual(state["containment"], "windows-job-list")
                self.assertEqual("root" in state, stage != "created")
                self.assertTrue(self.finish(self.spawn("print('{}')"))["cleanup_confirmed"])

    @unittest.skipUnless(os.name == "nt", "Requires native Windows Job Objects")
    def test_missing_legacy_job_does_not_prove_suspended_process_exited(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], creationflags=4)
        self.processes.append(other)
        lock = SessionLock("codex", "native"); self.assertTrue(lock.try_acquire())
        lock.write({"status":"running", "job":"missing-old-job", "pid":other.pid}); lock.close()
        result = self.finish(self.spawn("print('{}')"))
        self.assertFalse(result["cleanup_confirmed"]); self.assertIsNone(other.poll())
        self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")

    @unittest.skipUnless(os.name == "nt", "Requires native Windows process creation times")
    def test_windows_recovery_does_not_kill_recycled_pid_identity(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.processes.append(other)
        identity, _ = task_process.windows_identity(other.pid)
        # A trusted atomic-containment record whose old PID was since reused.
        old = {**identity, "created": identity["created"] - 1}
        task_process.recover({"version": 2, "containment": "windows-job-list", "status": "running",
                              "job": "PocketVibeTask-missing-test-job", "owner": old, "root": old})
        self.assertIsNone(other.poll())

    @unittest.skipUnless(os.name == "nt" or sys.platform.startswith("linux"), "Requires supported containment")
    def test_native_creation_exception_cleans_child_before_reporting_idle(self):
        original = subprocess.Popen
        def failing_create(command, **kwargs):
            proc = original(command, **kwargs)
            self.processes.append(proc)
            raise RuntimeError("injected failure after native creation")
        idle = []
        def observe(frame):
            if frame.get("status") == "idle":
                idle.append(frame)
                self.assertIsNotNone(self.processes[0].poll(), "Idle published before task child exited")
        spec = {"task": {}, "command": [sys.executable, "-c", "import time; time.sleep(30)"],
                "timeout": 3, "provider": "codex", "session_id": "native", "working_dir": str(self.root)}
        with patch.object(task_process.subprocess, "Popen", side_effect=failing_create), patch.object(task_process, "emit", side_effect=observe):
            result = task_process.run(spec)
        self.assertFalse(result["ok"]); self.assertTrue(result["cleanup_confirmed"])
        self.assertTrue(idle); self.assertEqual(execution_status("codex", "native"), "idle")

    def test_unsupported_posix_does_not_fall_back_to_session_only_cleanup(self):
        with patch.object(sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "task was not started"):
                LinuxTaskTree()


if __name__ == "__main__": unittest.main()
