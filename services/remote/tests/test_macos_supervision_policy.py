"""Portable policy/branch simulation. NOT native macOS acceptance."""
import asyncio
import errno
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "device"))
import macos_task as mac
import task_process
import desktop_agent
import desktop_control_panel as panel
from session_runtime import SessionLock


class Kernel:
    boot = "simulated-boot"
    def __init__(self):
        self.owner = {"pid": os.getpid(), "unique_id": 100, "boot_id": self.boot, "pidversion": 10}
        self.counts = (1, 0); self.rows = []; self.killed = []
    def identity(self, pid): return self.owner if pid == os.getpid() else None
    def coalition(self, pid): return 10 if pid == os.getpid() else 20
    def usage(self, cid): return self.counts
    def members(self, cid): return self.rows
    def alive(self, identity): return False
    def kill(self, row, cid): self.killed.append(row)


class MacPolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"POCKET_VIBE_STATE_DIR": str(self.root / "state")}); self.env.start()
        self.kernel = Kernel()
    def tearDown(self): self.env.stop(); self.temp.cleanup()

    def test_darwin_production_branch_continues_two_native_turns_without_linux_or_windows(self):
        context = {"label": "fixture", "parent_coalition": 99}
        payloads = []
        def communicate(data, timeout):
            payloads.append(json.loads(data))
            return json.dumps({"last_message": f"reply-{len(payloads)}"}).encode(), b""
        proc = Mock(pid=901, returncode=0); proc.communicate.side_effect = communicate
        with patch.object(mac, "DarwinAPI", return_value=self.kernel), patch.object(sys, "platform", "darwin"), \
             patch.object(task_process, "LinuxTaskTree") as linux, patch.object(task_process, "WindowsJob") as windows, \
             patch.object(task_process.subprocess, "Popen", return_value=proc) as launch, patch.object(task_process, "emit"):
            tree = mac.MacTaskTree(context)
            for prompt in ("one", "two"):
                result = task_process.run({"task": {"session_id": "native", "cwd": str(self.root), "objective": prompt},
                    "command": ["configured-adapter"], "provider": "codex", "session_id": "native", "timeout": 2,
                    "working_dir": str(self.root)}, context, tree)
                self.assertTrue(result["ok"]); self.assertTrue(result["cleanup_confirmed"])
            linux.assert_not_called(); windows.assert_not_called()
            self.assertEqual(launch.call_args.kwargs["cwd"], str(self.root))
        self.assertEqual([p["session_id"] for p in payloads], ["native", "native"])
        self.assertEqual([p["objective"] for p in payloads], ["one", "two"])

    def test_empty_scan_and_dead_root_are_not_exit_proof(self):
        with patch.object(mac, "DarwinAPI", return_value=self.kernel): tree = mac.MacTaskTree({"parent_coalition": 99})
        self.kernel.counts = (4, 2)  # Guardian + an unenumerated descendant.
        with patch.object(mac.time, "monotonic", side_effect=[0, 11]):
            with self.assertRaisesRegex(RuntimeError, "live descendants"): tree.cleanup(None, lambda _: None)

    def test_counter_loss_or_pid_absence_keeps_recovery_unconfirmed_and_blocks_next_turn(self):
        state = {"status": "cleanup-unconfirmed", "exclusive": True, "containment": "macos-resource-coalition",
                 "coalition_id": 20, "owner": {"pid": 901, "unique_id": 80, "boot_id": self.kernel.boot}, "started": 1}
        lock = SessionLock("codex", "native"); self.assertTrue(lock.try_acquire()); lock.write(state); lock.close()
        with patch.object(mac, "DarwinAPI", return_value=self.kernel), patch.object(sys, "platform", "darwin"), \
             patch.object(task_process.subprocess, "Popen") as launch, patch.object(task_process, "emit"), \
             patch.object(self.kernel, "usage", side_effect=OSError(errno.ESRCH, "coalition gone")):
            result = task_process.run({"task": {}, "provider": "codex", "session_id": "native", "timeout": 2}, {"label": "new"}, Mock())
            launch.assert_not_called(); self.assertFalse(result["cleanup_confirmed"])

    def test_recovery_requires_kernel_zero_and_boot_identity(self):
        state = {"exclusive": True, "containment": "macos-resource-coalition", "coalition_id": 20,
                 "owner": {"pid": 901, "unique_id": 80, "boot_id": self.kernel.boot}, "started": 1}
        with patch.object(mac, "DarwinAPI", return_value=self.kernel):
            self.kernel.counts = (3, 3); mac.recover_macos(state)
            mac.recover_macos({"owner": {"boot_id": "different-boot"}})
            with self.assertRaises(RuntimeError): mac.recover_macos({"status": "running", "pid": 901})

    def test_identity_mismatch_never_reaches_native_signal(self):
        api = mac.DarwinAPI.__new__(mac.DarwinAPI)
        api.proc = Mock(); api.identity = Mock(return_value={"pid": 42, "unique_id": 200, "boot_id": "boot"})
        api.coalition = Mock(return_value=10)
        api.kill({"pid": 42, "unique_id": 100, "boot_id": "boot"}, 10)
        api.proc.proc_signal_with_audittoken.assert_not_called()

    def test_launch_submission_failure_retains_reservation_and_recovery_files(self):
        with patch.object(mac, "DarwinAPI", return_value=self.kernel), \
             patch.object(mac.os, "getuid", return_value=501, create=True), \
             patch.object(mac, "launchctl", side_effect=RuntimeError("submission outcome unknown")):
            with self.assertRaisesRegex(RuntimeError, "unknown"):
                mac.launch_task({"task": {}, "provider": "codex", "session_id": "native"}, lambda _: None)
        lock = SessionLock("codex", "native"); state = lock.read(); lock.close()
        self.assertEqual(state["containment"], "macos-launch-pending")
        self.assertTrue(Path(state["macos_job"]["folder"], "context.json").exists())
        with patch.object(mac, "DarwinAPI", return_value=self.kernel):
            with self.assertRaisesRegex(RuntimeError, "reservation retained"): mac.recover_macos(state)

    def test_missing_native_capability_is_visible_before_join_and_launch(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"command": ["never-run"], "capabilities": ["codex.exec"]}))
        bridge = desktop_agent.DesktopBridge("unused", "x", "fixture", local_agent_config=str(config))
        with patch.object(desktop_agent, "execution_support_error", return_value="macOS 隔离能力不可用"), \
             patch.object(panel, "discover_sessions", return_value=[{"session_id": "native", "cwd": str(self.root)}]), \
             patch.object(asyncio, "create_subprocess_exec") as launch:
            self.assertNotIn("codex.exec", bridge._capabilities()); self.assertIn("codex.sessions", bridge._capabilities())
            self.assertNotIn("agent.echo", bridge._capabilities())
            self.assertFalse(bridge._hello_payload()["execution_available"])
            row = bridge._scan_sessions()["sessions"][0]
            self.assertFalse(row["available"]); self.assertIn("能力不可用", row["error"])
            result = asyncio.run(bridge.local_agent.run({"payload": {}}))
            self.assertFalse(result["ok"]); launch.assert_not_called()


if __name__ == "__main__": unittest.main()
