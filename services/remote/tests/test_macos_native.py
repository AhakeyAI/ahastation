"""Run on real macOS: python3 -m unittest discover -s tests -p test_macos_native.py -v.

No model calls. Requires the actual native capability probe to succeed; failures
are not skipped on macOS. All files/processes/jobs belong to this test's state.
"""
import asyncio
import ctypes
import errno
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

DEVICE = Path(__file__).resolve().parents[1] / "device"
sys.path.insert(0, str(DEVICE))
import macos_task as mac
from desktop_agent import LocalAgentRunner, DesktopBridge
from session_runtime import SessionLock, device_id, execution_status


@unittest.skipUnless(sys.platform == "darwin", "待真实 macOS 验收；平台模拟不算原生实测")
class MacNativeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pocket-macos-native-"); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "POCKET_VIBE_STATE_DIR": str(self.root / "state"), "POCKET_VIBE_TEST_FAULTS": "1"})
        self.env.start(); self.processes = []
        self.addCleanup(self.temp.cleanup); self.addCleanup(self.env.stop)
        self.native = "12345678-1234-1234-1234-123456789abc"
        self.project = self.root / "project"; self.project.mkdir()
        session_dir = self.root / ".codex" / "sessions"; session_dir.mkdir(parents=True)
        (session_dir / f"{self.native}.jsonl").write_text(json.dumps({"type": "session_meta", "payload": {"cwd": str(self.project)}}))
        self.api = mac.DarwinAPI()
        self.assertEqual(mac.macos_support_error(), "", "Native capability unavailable; macOS implementation has NOT passed acceptance")

    def tearDown(self):
        # Enumerate only test-owned job records, never process names/SIDs.
        jobs = self.root / "state" / "macos-tasks"
        for path in jobs.glob("*/context.json"):
            identity_file = path.with_name("guardian.json")
            record = json.loads(identity_file.read_text()) if identity_file.exists() else {}
            if record.get("exclusive") and record["owner"]["boot_id"] == self.api.boot:
                for row in self.api.members(record["coalition_id"]): self.api.kill(row, record["coalition_id"])
            context = json.loads(path.read_text())
            try: mac.launchctl("bootout", context["service"])
            except RuntimeError: pass
        for proc in self.processes:
            if proc.poll() is None: proc.kill()
            proc.wait(timeout=15)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream: stream.close()
        for path in jobs.glob("*/guardian.json"):
            record = json.loads(path.read_text())
            if record.get("exclusive"):
                self.until(lambda: not self.api.members(record["coalition_id"]))

    def until(self, condition):
        deadline = time.monotonic() + 20
        while not condition():
            if time.monotonic() > deadline: self.fail("Native task did not reach expected state")
            time.sleep(.02)

    def spawn(self, code, timeout=8, fault=None, pinned=True):
        spec = {"task": {}, "command": [sys.executable, "-c", code], "timeout": timeout, "working_dir": str(self.project),
                "provider": "codex", "session_id": self.native if pinned else "", "_test_fault": fault}
        proc = subprocess.Popen([sys.executable, "-u", str(DEVICE / "task_process.py")], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.processes.append(proc); proc.stdin.write(json.dumps(spec)); proc.stdin.close()
        return proc

    def running(self, proc):
        while line := proc.stdout.readline():
            if json.loads(line).get("status") == "running": return
        self.fail(proc.stderr.read())

    def finish(self, proc):
        frames = [json.loads(line) for line in proc.stdout]; proc.wait(timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr.read())
        return next(row["result"] for row in frames if row.get("type") == "result")

    def runner(self, code, pinned=False):
        config = self.root / "config.json"
        command = [sys.executable, "-c", code]
        if pinned: command.extend(["--session-id", self.native])
        config.write_text(json.dumps({"command": command, "capabilities": ["codex.exec"], "working_dir": str(self.project)}))
        return LocalAgentRunner(str(config))

    def detached(self):
        marker = self.project / "late-write"; identity = self.project / "child.json"
        child = (f"import sys,os,json,time; sys.path.insert(0,{str(DEVICE)!r}); from macos_task import DarwinAPI; from pathlib import Path; "
                 f"Path({str(identity)!r}).write_text(json.dumps(DarwinAPI().identity(os.getpid()))); "
                 f"time.sleep(4); Path({str(marker)!r}).touch(); time.sleep(20)")
        launch = f"import sys,subprocess,time; subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        return launch, marker, identity

    def test_legacy_targetless_call_and_fixed_session_config_return_text(self):
        for pinned in (False, True):
            with self.subTest(pinned=pinned):
                result = asyncio.run(self.runner("print('{\"last_message\":\"legacy reply\"}')", pinned).run({"payload": {"objective": "legacy"}}))
                self.assertTrue(result["ok"], result); self.assertTrue(result["cleanup_confirmed"])
                self.assertEqual(result["json"]["last_message"], "legacy reply")

    def test_selected_native_session_two_turns_same_id_cwd_and_feedback(self):
        code = ("import sys,json,os; from pathlib import Path; task=json.load(sys.stdin); "
                "path=Path('rounds.txt'); path.write_text((path.read_text() if path.exists() else '')+task['objective']); "
                "print(json.dumps({'last_message':task['session_id']+':'+path.read_text()+':'+os.getcwd()}))")
        runner = self.runner(code)
        target = {"agent_id": "fixture", "device_id": device_id(), "provider": "codex", "session_id": self.native, "cwd": str(self.project)}
        for text in ("one", "two"):
            result = asyncio.run(runner.run({"payload": {"objective": text, "provider": "codex", "session_id": self.native,
                                "cwd": str(self.project), "turn_options": {"mode": "resume"}, "remote_target": target}}))
            self.assertTrue(result["ok"], result); self.assertTrue(result["cleanup_confirmed"])
            self.assertIn(self.native, result["json"]["last_message"]); self.assertIn(str(self.project), result["json"]["last_message"])
        self.assertEqual((self.project / "rounds.txt").read_text(), "onetwo")

    def test_cross_bridge_processes_serialize_same_native_session(self):
        code = ("import sys,json,time; from pathlib import Path; task=json.load(sys.stdin); label=task['objective']; "
                "Path(label).touch(); time.sleep(1 if label=='first' else 0); print(json.dumps({'last_message':label}))")
        self.runner(code)
        bridges = [DesktopBridge("unused", "x", name, local_agent_config=str(self.root / "config.json")) for name in ("entry-a", "entry-b")]
        class Socket:
            def __init__(self): self.frames = []; self.running = asyncio.Event(); self.waiting = asyncio.Event()
            async def send(self, raw):
                frame = json.loads(raw); self.frames.append(frame)
                if frame["type"] == "task_state" and frame["payload"]["status"] == "running": self.running.set()
                if frame["type"] == "task_state" and frame["payload"]["status"] == "waiting": self.waiting.set()
        async def turns():
            sockets = [Socket(), Socket()]
            def message(index):
                target = {"agent_id": bridges[index].agent_id, "device_id": device_id(), "provider": "codex", "session_id": self.native, "cwd": str(self.project)}
                return {"task_id": f"fixture-{index}", "payload": {"objective": ('first','second')[index], "provider":"codex",
                        "session_id":self.native, "cwd":str(self.project), "remote_target":target}}
            first = asyncio.create_task(bridges[0]._execute_and_report(sockets[0], message(0)))
            # Include the cold-start reservation → launchd lock handoff, not
            # only turns submitted once the first CLI is already running.
            deadline = time.monotonic() + 20
            while True:
                lock = SessionLock('codex', self.native); state = lock.read(); lock.close()
                if state: break
                if time.monotonic() > deadline: self.fail('No native task reservation')
                await asyncio.sleep(.01)
            second = asyncio.create_task(bridges[1]._execute_and_report(sockets[1], message(1)))
            await sockets[1].waiting.wait(); await asyncio.sleep(.1)
            self.assertFalse((self.project / "second").exists())
            await asyncio.gather(first, second)
            for index, ws in enumerate(sockets):
                result = next(frame["payload"] for frame in ws.frames if frame["type"] == "result")
                self.assertTrue(result["ok"], result); self.assertTrue(result["cleanup_confirmed"])
                self.assertEqual(result["json"]["last_message"], ('first','second')[index])
        asyncio.run(turns())
        self.assertTrue((self.project / "second").exists())

    def test_normal_return_cleans_setsid_child_after_adapter_exits(self):
        launch, marker, identity = self.detached()
        root = launch + f"\nfrom pathlib import Path\nwhile not Path({str(identity)!r}).exists(): time.sleep(.01)\nprint('{{}}')"
        result = self.finish(self.spawn(root)); self.assertTrue(result["ok"], result); self.assertTrue(result["cleanup_confirmed"])
        old = json.loads(identity.read_text()); self.assertFalse(self.api.alive(old))
        time.sleep(4.1); self.assertFalse(marker.exists())

    def test_timeout_double_fork_parent_exits_cleans_chain_before_next_turn(self):
        launch, marker, identity = self.detached()
        intermediate = launch + "sys.exit(0)"
        root = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{intermediate!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(30)"
        first = self.spawn(root, timeout=2); self.running(first); self.until(identity.exists)
        next_file = self.project / "next-after-timeout"
        second = self.spawn(f"from pathlib import Path; Path({str(next_file)!r}).touch(); print('{{}}')")
        self.assertFalse(next_file.exists())
        result = self.finish(first); self.assertFalse(result["ok"]); self.assertTrue(result["cleanup_confirmed"], result)
        self.assertFalse(self.api.alive(json.loads(identity.read_text())))
        self.assertTrue(self.finish(second)["ok"]); time.sleep(4.1); self.assertFalse(marker.exists())

    def test_guardian_crash_never_uses_pid_absence_as_cleanup_proof(self):
        launch, marker, identity = self.detached()
        first = self.spawn(launch + "time.sleep(30)"); self.running(first); self.until(identity.exists)
        lock = SessionLock("codex", self.native); state = lock.read(); lock.close()
        self.api.kill(state["owner"], state["coalition_id"])
        self.assertFalse(self.finish(first)["cleanup_confirmed"])
        next_file = self.project / "after-crash"
        result = self.finish(self.spawn(f"from pathlib import Path; Path({str(next_file)!r}).touch()"))
        if result["cleanup_confirmed"]:
            self.assertFalse(self.api.alive(json.loads(identity.read_text())))
        else:
            self.assertFalse(next_file.exists()); self.assertEqual(execution_status("codex", self.native), "cleanup-unconfirmed")
        time.sleep(4.1); self.assertFalse(marker.exists())

    def test_creation_metadata_faults_block_unconfirmed_next_task(self):
        for stage in ("macos-reserved", "macos-before-guardian-record", "created", "recorded"):
            with self.subTest(stage=stage):
                # Separate native identity for each deliberately quarantined turn.
                self.native = str(__import__('uuid').uuid4())
                first = self.spawn("import time; time.sleep(30)", fault=stage)
                if stage == "macos-reserved": first.stdout.read(); first.wait(); self.assertEqual(first.returncode, 97)
                else: self.assertFalse(self.finish(first)["cleanup_confirmed"])
                lock = SessionLock("codex", self.native); previous = lock.read(); lock.close()
                owned = self.api.members(previous["coalition_id"]) if previous.get("exclusive") else []
                marker = self.project / f"should-not-start-{stage}"
                result = self.finish(self.spawn(f"from pathlib import Path; Path({str(marker)!r}).touch()"))
                if stage in ("macos-reserved", "macos-before-guardian-record"):
                    self.assertFalse(result["cleanup_confirmed"], "Unknown launch outcome was incorrectly cleared")
                    self.assertTrue(Path(previous["macos_job"]["folder"], "context.json").exists())
                if result["cleanup_confirmed"]:
                    self.assertFalse(any(self.api.alive(row) for row in owned), "Next turn ran before owned children exited")
                else:
                    self.assertFalse(marker.exists())
                    self.assertEqual(execution_status("codex", self.native), "cleanup-unconfirmed")

    def test_pid_identity_mismatch_never_signals_other_test_process(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"]); self.processes.append(other)
        identity = self.api.identity(other.pid)
        self.api.kill({**identity, "unique_id": identity["unique_id"] + 1}, self.api.coalition(other.pid))
        self.assertIsNone(other.poll())
        token = (ctypes.c_uint32 * 8)(0, os.geteuid(), os.getegid(), os.getuid(), os.getgid(), other.pid, 0, identity["pidversion"]+1)
        self.assertIn(self.api.proc.proc_signal_with_audittoken(token, 9), (errno.ESRCH, errno.ENOENT))
        self.assertIsNone(other.poll(), "Kernel signalled a mismatched PID version")

    def test_unconfirmed_legacy_record_blocks_task_without_deleting_reference(self):
        lock = SessionLock("codex", self.native); self.assertTrue(lock.try_acquire())
        lock.write({"status": "cleanup-unconfirmed", "pid": 999999}); lock.close()
        marker = self.project / "must-not-run"
        result = self.finish(self.spawn(f"from pathlib import Path; Path({str(marker)!r}).touch()"))
        self.assertFalse(result["cleanup_confirmed"]); self.assertFalse(marker.exists())
        self.assertEqual(execution_status("codex", self.native), "cleanup-unconfirmed")


if __name__ == "__main__": unittest.main()
