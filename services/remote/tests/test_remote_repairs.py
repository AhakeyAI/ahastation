"""Real OS process/lock regressions; all commands operate on temporary fixtures."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "device"))
import device_hub as hub
import task_process
import desktop_control_panel as panel
from desktop_agent import DesktopBridge, LocalAgentRunner
from session_runtime import device_id, execution_status, SessionLock
from protocol import envelope
from fastapi import HTTPException

GUARDIAN = Path(__file__).resolve().parents[1] / "device" / "task_process.py"


class RepairTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"POCKET_VIBE_STATE_DIR": str(self.root / "state")})
        self.env.start()
        hub.agents.clear(); hub.tasks.clear()
        self.logs = patch.multiple(hub, RUNTIME_DIR=self.root, EVENT_LOG=self.root / "events.jsonl")
        self.logs.start()
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=15)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream: stream.close()
        self.logs.stop(); self.env.stop(); self.temp.cleanup()

    def spawn(self, code, timeout=5, native="native", provider="codex"):
        spec = {"task": {}, "command": [sys.executable, "-c", code], "timeout": timeout,
                "working_dir": str(self.root), "provider": provider, "session_id": native}
        child = subprocess.Popen([sys.executable, "-u", str(GUARDIAN)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.children.append(child)
        child.stdin.write(json.dumps(spec)); child.stdin.close()
        return child

    def running(self, child):
        while line := child.stdout.readline():
            if json.loads(line).get("status") == "running": return
        self.fail(child.stderr.read())

    def finish(self, child):
        frames = [json.loads(line) for line in child.stdout]
        child.wait(timeout=15)
        self.assertEqual(child.returncode, 0, child.stderr.read())
        return next(frame["result"] for frame in frames if frame["type"] == "result")

    def test_device_identity_shared_by_agent_ids_and_persists_across_processes(self):
        a = DesktopBridge("unused", "x", "entry-a")
        b = DesktopBridge("unused", "x", "entry-b")
        self.assertEqual(a.device_id, b.device_id)
        remote = subprocess.check_output([sys.executable, "-c", "from session_runtime import device_id; print(device_id())"],
                                        cwd=str(GUARDIAN.parent), text=True).strip()
        self.assertEqual(remote, a.device_id)

    def test_cross_process_lock_and_timeout_kill_cli_descendant_before_unlock(self):
        marker = self.root / "late-write"
        child_code = f"import time; from pathlib import Path; time.sleep(.9); Path({str(marker)!r}).write_text('bad')"
        code = f"import subprocess,sys,time,os; subprocess.Popen([sys.executable,'-c',{child_code!r}],creationflags=0x200 if os.name=='nt' else 0); time.sleep(20)"
        first = self.spawn(code, timeout=.35)
        self.running(first)
        self.assertEqual(execution_status("codex", "native"), "running")
        second_marker = self.root / "second"
        second = self.spawn(f"from pathlib import Path; Path({str(second_marker)!r}).write_text('ok')")
        self.assertEqual(json.loads(second.stdout.readline())["status"], "waiting")
        self.assertFalse(second_marker.exists())
        result = self.finish(first)
        self.assertFalse(result["ok"]); self.assertTrue(result["cleanup_confirmed"])
        self.assertIn("timed out", result["error"])
        self.assertTrue(self.finish(second)["ok"])
        time.sleep(1)
        self.assertFalse(marker.exists())
        self.assertTrue(second_marker.exists())
        self.assertEqual(execution_status("codex", "native"), "idle")

    def test_guardian_crash_recovery_does_not_leave_lock_or_children(self):
        marker = self.root / "orphan"
        code = f"import time; from pathlib import Path; time.sleep(.8); Path({str(marker)!r}).write_text('bad'); time.sleep(20)"
        first = self.spawn(code)
        self.running(first)
        if sys.platform == "darwin":
            # On macOS this Popen is the protocol proxy. Kill the actual
            # test-owned launchd guardian, not its waiting Bridge/proxy.
            from macos_task import DarwinAPI
            lock = SessionLock("codex", "native"); state = lock.read(); lock.close()
            DarwinAPI().kill(state["owner"], state["coalition_id"])
            self.assertFalse(self.finish(first)["cleanup_confirmed"])
        else:
            first.kill(); first.wait()
        second = self.spawn("print('{}')")
        result = self.finish(second)
        if sys.platform == "darwin":
            if not result["cleanup_confirmed"]:
                self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")
        else:
            self.assertEqual(result["cleanup_confirmed"], os.name == "nt")
        time.sleep(1)
        self.assertFalse(marker.exists())

    def test_bridge_parent_exit_does_not_release_guardians_lock_early(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"command": [sys.executable, "-c", "import time; time.sleep(2)"],
                                      "capabilities": ["codex.exec"], "timeout_seconds": 4}))
        code = f"""import asyncio,os
from desktop_agent import LocalAgentRunner
async def main():
    async def state(value):
        if value == 'running': os._exit(0)
    await LocalAgentRunner({str(config)!r}).run({{'payload': {{'provider':'codex','session_id':'native'}}}}, state)
asyncio.run(main())
"""
        parent = subprocess.Popen([sys.executable, "-c", code], cwd=str(GUARDIAN.parent))
        self.children.append(parent); parent.wait(timeout=10)
        self.assertEqual(execution_status("codex", "native"), "running")
        second = self.spawn("print('{}')")
        self.assertTrue(self.finish(second)["ok"])

    def test_local_runner_exception_cleans_up_and_legacy_task_works(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"command": ["nonexistent-test-command"], "capabilities": ["codex.exec"]}))
        result = asyncio.run(LocalAgentRunner(str(config)).run({"payload": {"session_id": "native", "provider": "codex"}}))
        self.assertFalse(result["ok"]); self.assertTrue(result["cleanup_confirmed"])
        config.write_text(json.dumps({"command": [sys.executable, "-c", "print('{\"last_message\":\"legacy\"}')"]}))
        result = asyncio.run(LocalAgentRunner(str(config)).run({"payload": {"objective": "legacy"}}))
        self.assertTrue(result["ok"]); self.assertEqual(result["json"]["last_message"], "legacy")

    def test_offline_invalid_and_disconnect_race_never_enter_strict_waiting_queue(self):
        target = {"agent_id": "a", "device_id": device_id(), "provider": "codex", "session_id": "native", "cwd": str(self.root)}
        class Socket:
            async def send_json(self, _): raise OSError("disconnected")
        async def run():
            with self.assertRaises(HTTPException): hub.validate_remote_target(target)
            agent = hub.DesktopAgent("a", Socket(), device_id=target["device_id"], capabilities=["codex.exec"],
                                     catalog_status="ready", remote_sessions=[{"session_id": "native", "cwd": str(self.root), "provider": "codex"}])
            hub.agents["a"] = agent
            for overrides in ({"provider":"claude"}, {"cwd":"wrong"}, {"device_id":"wrong"}, {"session_id":"gone"}):
                with self.assertRaises(HTTPException): hub.validate_remote_target({**target, **overrides})
            agent.remote_sessions[0]["available"] = False
            with self.assertRaises(HTTPException): hub.validate_remote_target(target)
            agent.remote_sessions[0]["available"] = True
            task = await hub.create_and_route_task("fixture", requested_agent_id="a", extra_payload={"require_online":True,"remote_target":target})
            self.assertEqual(task["status"], "failed")
            hub.agents.clear()
            with self.assertRaises(HTTPException):
                await hub.create_and_route_task("fixture", requested_agent_id="a", extra_payload={"require_online":True,"remote_target":target})
            legacy = await hub.create_and_route_task("fixture", requested_agent_id="a")
            self.assertEqual(legacy["status"], "waiting_for_agent")
            self.assertFalse(any(t.get("require_online") and t["status"] == "waiting_for_agent" for t in hub.tasks.values()))
        asyncio.run(run())

    def test_unconfirmed_cleanup_blocks_execution_and_recovers_without_claiming_idle(self):
        lock = SessionLock("codex", "native"); self.assertTrue(lock.try_acquire())
        lock.write({"status":"cleanup-unconfirmed", "job":"fixture-missing-job"}); lock.close()
        spec = {"task":{},"command":[sys.executable,"-c","print('{}')"],"timeout":3,"provider":"codex","session_id":"native"}
        with patch.object(task_process, "recover", side_effect=RuntimeError("cannot confirm")), patch.object(task_process.subprocess, "Popen") as launch, patch.object(task_process, "emit"):
            result = task_process.run(spec)
            launch.assert_not_called()
            self.assertFalse(result["cleanup_confirmed"])
            self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")
        self.assertFalse(self.finish(self.spawn("print('{}')"))["cleanup_confirmed"])
        self.assertEqual(execution_status("codex", "native"), "cleanup-unconfirmed")

    def test_bridge_rejects_reference_parameter_mismatch_before_executor(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"command":["never-run"],"capabilities":["codex.exec"]}))
        bridge = DesktopBridge("unused","x","entry",local_agent_config=str(config))
        target={"agent_id":"entry","device_id":bridge.device_id,"provider":"codex","session_id":"native","cwd":str(self.root)}
        class Socket:
            def __init__(self): self.messages=[]
            async def send(self, data): self.messages.append(json.loads(data))
        async def run():
            with patch.object(panel,"discover_sessions",return_value=[{"session_id":"native","cwd":str(self.root)}]), patch.object(bridge,"_execute_task") as execute:
                for changes in ({"provider":"claude"},{"session_id":"wrong"},{"cwd":"wrong"},{"turn_options":{"session_id":"wrong"}}):
                    payload={"provider":"codex","session_id":"native","cwd":str(self.root),"remote_target":target,**changes}
                    ws=Socket(); await bridge._execute_and_report(ws,envelope("task",payload,task_id="fixture"))
                    self.assertFalse(next(m for m in ws.messages if m["type"]=="result")["payload"]["ok"])
                execute.assert_not_called()
        asyncio.run(run())


if __name__ == "__main__": unittest.main()
