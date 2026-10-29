"""Offline tests: fixture session files, in-process Hub, no model or user project."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "device"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))

from fastapi.testclient import TestClient
import desktop_control_panel as panel
import device_hub as hub
from desktop_agent import DesktopBridge
from protocol import envelope
from codex_cli_adapter import build_codex_command
from claude_code_adapter import build_claude_command


class RemoteSessionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = patch.dict(os.environ, {"POCKET_VIBE_STATE_DIR": str(self.root / "state")})
        self.state.start()
        self.session_id = "12345678-1234-1234-1234-123456789abc"
        self.cwd = "C:\\remote  project"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"command": ["never-run"], "capabilities": ["codex.exec"]}), encoding="utf-8")
        self.bridge = DesktopBridge("ws://unused", "test", "fixture-agent", local_agent_config=str(self.config))
        hub.agents.clear()
        hub.tasks.clear()
        self.log = patch.object(hub, "RUNTIME_DIR", self.root)
        self.log.start()
        self.event_log = patch.object(hub, "EVENT_LOG", self.root / "events.jsonl")
        self.event_log.start()

    def tearDown(self):
        self.event_log.stop()
        self.log.stop()
        self.state.stop()
        self.temp.cleanup()

    def scan(self, provider="codex"):
        entries = [{"type": "session_meta", "payload": {"cwd": self.cwd}},
                   {"type": "response_item", "payload": {"role": "user", "content": "Fix fixture"}}]
        if provider == "claude":
            entries = [{"type": "user", "cwd": self.cwd, "message": {"role": "user", "content": "Claude fixture"}}]
        (self.root / f"{self.session_id}.jsonl").write_text("\n".join(json.dumps(x) for x in entries), encoding="utf-8")
        with patch.object(panel, "session_roots", return_value=[self.root]), patch.object(panel, "load_codex_thread_index", return_value={}):
            return panel.discover_sessions(provider, strict=True)

    def test_bridge_to_hub_catalog_refresh_uses_native_scanner_and_whitelist(self):
        rows = self.scan()
        with patch.object(panel, "discover_sessions", return_value=rows), TestClient(hub.app) as client:
            self.assertEqual(client.get("/v1/remote-sessions").status_code, 401)
            headers = {"X-Pocket-Token": hub.TOOL_TOKEN}
            self.assertEqual(client.get("/v1/remote-sessions", headers=headers).json()["status"], "disconnected")
            with client.websocket_connect(f"/ws/desktop?token={hub.DEV_TOKEN}&agent_id=fixture-agent") as ws:
                ws.send_json(envelope("hello", self.bridge._hello_payload()))
                ws.send_json(envelope("session_catalog", self.bridge._scan_sessions()))
                # Ordered messages: pong barrier ensures Hub processed the catalog.
                ws.send_json(envelope("pong"))
                for _ in range(100):
                    directory = client.get("/v1/remote-sessions", headers=headers).json()
                    if directory["sessions"]:
                        break
                item = directory["sessions"][0]
                self.assertEqual(set(item), {"agent_id", "device_id", "provider", "session_id", "title", "cwd", "computer_name", "execution_status", "native_client_status", "available", "error"})
                self.assertEqual(item["device_id"], self.bridge.device_id)
                self.assertEqual(item["native_client_status"], "unknown")
                self.assertEqual((item["agent_id"], item["provider"], item["session_id"], item["cwd"]),
                                 ("fixture-agent", "codex", self.session_id, self.cwd))
                legacy = client.get("/v1/sessions", headers=headers).json()
                self.assertEqual(legacy["sessions"][0]["session_id"], "fixture-agent")

    def test_refresh_request_reuses_bridge_scanner_and_reports_failure(self):
        class Socket:
            def __init__(self): self.messages = []
            async def send(self, raw): self.messages.append(json.loads(raw))
        async def run():
            ws = Socket()
            with patch.object(panel, "discover_sessions", side_effect=PermissionError("fixture denied")):
                await self.bridge._handle_message(ws, envelope("refresh_sessions", {}, msg_id="refresh-1"))
                await asyncio.gather(*self.bridge.pending_tasks)
            payload = ws.messages[0]["payload"]
            self.assertEqual(payload["request_id"], "refresh-1")
            self.assertEqual(payload["status"], "failed")
            self.assertIn("fixture denied", payload["error"])
            self.assertEqual(payload["sessions"], [])
        asyncio.run(run())

    def test_empty_unsupported_and_legacy_bridge_are_distinct(self):
        with patch.object(panel, "discover_sessions", return_value=[]):
            self.assertEqual(self.bridge._scan_sessions()["status"], "empty")
        echo = DesktopBridge("ws://unused", "test")
        self.assertEqual(echo._scan_sessions()["status"], "unsupported")
        self.assertNotIn("remote.sessions", echo._capabilities())
        with TestClient(hub.app) as client:
            with client.websocket_connect(f"/ws/desktop?token={hub.DEV_TOKEN}&agent_id=legacy") as ws:
                ws.send_json(envelope("hello", {"capabilities": ["codex.exec"]}))
                result = client.get("/v1/remote-sessions?refresh=true", headers={"X-Pocket-Token": hub.TOOL_TOKEN}).json()
                self.assertEqual(result["agents"][0]["status"], "unsupported")

    def test_claude_scanner_returns_remote_cwd_and_title(self):
        row = self.scan("claude")[0]
        self.assertEqual(row["cwd"], self.cwd)
        self.assertEqual(row["title"], "Claude fixture")

    def test_scanner_reports_unreadable_session_without_changing_console_default(self):
        self.scan()
        with patch.object(Path, "open", side_effect=PermissionError("fixture")):
            self.assertTrue(panel.extract_session_summary("codex", self.root / "x", self.session_id))
            with self.assertRaises(PermissionError):
                panel.extract_session_summary("codex", self.root / "x", self.session_id, strict=True)

    def test_selected_session_overrides_config_cwd_and_last_for_both_adapters(self):
        from argparse import Namespace
        task = {"session_id": self.session_id, "cwd": self.cwd, "turn_options": {"mode": "resume"}}
        codex_args = Namespace(mode="exec", session_id="other", cwd="station-local", model="", reasoning_effort="", json_events=True, last=True, skip_git_repo_check=True, sandbox="workspace-write", approval="never")
        command, _, cwd = build_codex_command(codex_args, task)
        self.assertIn(self.session_id, command)
        self.assertNotIn("--last", command)
        self.assertEqual(cwd, self.cwd)
        self.assertEqual(command[:7], ["codex", "exec", "--sandbox", "workspace-write", "-c", 'approval_policy="never"', "resume"])
        self.assertNotIn("--sandbox", command[7:])
        claude_args = Namespace(mode="exec", session_id="other", cwd="station-local", output_format="json", model="", effort="", agent="", permission_mode="default", max_budget_usd="", system_prompt_file="", bare=False, allowed_tool=[], disallowed_tool=[])
        command, cwd = build_claude_command(claude_args, task)
        self.assertEqual(command[command.index("--resume") + 1], self.session_id)
        self.assertEqual(cwd, self.cwd)

    def test_executor_exception_returns_failed_result_in_existing_queue(self):
        class Socket:
            def __init__(self): self.messages = []
            async def send(self, raw): self.messages.append(json.loads(raw))
        async def fail(*_): raise PermissionError("fixture execution denied")
        async def run():
            ws = Socket()
            with patch.object(self.bridge, "_execute_task", side_effect=fail):
                await self.bridge._execute_and_report(ws, envelope("task", {}, task_id="failure-1"))
            result = next(msg for msg in ws.messages if msg["type"] == "result")
            self.assertFalse(result["payload"]["ok"])
            self.assertEqual(result["task_id"], "failure-1")
        asyncio.run(run())


if __name__ == "__main__": unittest.main()
