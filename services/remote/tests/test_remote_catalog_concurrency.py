"""Real async HTTP/WebSocket + native scanner tests; no model/executor calls."""
import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "device"))
import desktop_agent
import desktop_control_panel as panel
import device_hub as hub
from session_runtime import SessionLock


class ConcurrentCatalogTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pocket-catalog-")
        self.root = Path(self.temp.name)
        self.sessions = self.root / "sessions"; self.sessions.mkdir()
        self.ids = ["12345678-1234-1234-1234-123456789abc", "12345678-1234-1234-1234-123456789def"]
        self.cwd = self.root / "project"; self.cwd.mkdir()
        for native in self.ids:
            (self.sessions / f"{native}.jsonl").write_text("\n".join(json.dumps(row) for row in [
                {"type": "session_meta", "payload": {"cwd": str(self.cwd)}},
                {"type": "response_item", "payload": {"role": "user", "content": native}},
            ]), encoding="utf-8")
        self.patches = [
            patch.dict(os.environ, {"POCKET_VIBE_STATE_DIR": str(self.root / "state")}),
            patch.object(panel, "session_roots", return_value=[self.sessions]),
            patch.object(panel, "load_codex_thread_index", return_value={}),
            patch.object(hub, "RUNTIME_DIR", self.root),
            patch.object(hub, "EVENT_LOG", self.root / "events.jsonl"),
            patch.object(hub.router, "base_url", ""),
            patch.object(desktop_agent, "OUTBOX", self.root / "outbox.jsonl"),
        ]
        for item in self.patches: item.start()
        hub.agents.clear(); hub.tasks.clear(); hub.receipt_revision = 0
        self.socket = socket.socket(); self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(hub.app, log_level="error", lifespan="off"))
        self.server_task = asyncio.create_task(self.server.serve(sockets=[self.socket]))
        await self.until(lambda: self.server.started)
        self.http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.port}", headers={"X-Pocket-Token": hub.TOOL_TOKEN}, timeout=15, trust_env=False)
        config = self.root / "config.json"
        config.write_text(json.dumps({"command": ["never-run"], "capabilities": ["codex.exec"]}), encoding="utf-8")
        self.config = config
        self.bridges = []; self.connections = []; self.executed = []
        self.gate = threading.Event(); self.gate.set()
        self.scan_started = threading.Event(); self.scan_calls = 0
        await self.connect("fixture-agent")
        self.agent = hub.agents["fixture-agent"]

    async def connect(self, agent_id):
        bridge = desktop_agent.DesktopBridge(f"ws://127.0.0.1:{self.port}/ws/desktop", hub.DEV_TOKEN, agent_id,
                                             local_agent_config=str(self.config))
        scanner = bridge._scan_sessions

        def delayed_scan():
            self.scan_calls += 1; self.scan_started.set()
            if not self.gate.wait(10): raise TimeoutError("Test scan gate timed out")
            return scanner()  # Actual fixture JSONL and real kernel session lock.

        async def executor(msg, on_state):
            await on_state("running")
            self.executed.append(msg["payload"])
            await asyncio.sleep(.02)
            await on_state("idle")
            return {"ok": True, "cleanup_confirmed": True, "stdout": msg["payload"]["objective"]}

        bridge._scan_sessions = delayed_scan
        bridge.local_agent.run = executor  # Only the paid executor is replaced.
        self.bridges.append(bridge)
        self.connections.append(asyncio.create_task(bridge._connect_once()))
        await self.until(lambda: agent_id in hub.agents and hub.agents[agent_id].catalog_status == "ready")

    async def asyncTearDown(self):
        self.gate.set()
        for bridge in self.bridges:
            await asyncio.gather(*list(bridge.pending_tasks), return_exceptions=True)
        for connection in self.connections: connection.cancel()
        await asyncio.gather(*self.connections, return_exceptions=True)
        await asyncio.gather(*(agent.refresh_task for agent in list(hub.agents.values()) if agent.refresh_task), return_exceptions=True)
        await self.http.aclose()
        self.server.should_exit = True
        await asyncio.wait_for(self.server_task, 10)
        self.socket.close()
        for item in reversed(self.patches): item.stop()
        hub.agents.clear(); hub.tasks.clear()
        self.temp.cleanup()

    async def until(self, condition):
        deadline = time.monotonic() + 10
        while not condition():
            if time.monotonic() > deadline: self.fail("Async fixture did not reach expected state")
            await asyncio.sleep(.01)

    def hold_scan(self):
        self.scan_calls = 0; self.scan_started.clear(); self.gate.clear()

    def target(self, native=None):
        return {"agent_id": self.agent.agent_id, "device_id": self.agent.device_id, "provider": "codex",
                "session_id": native or self.ids[0], "cwd": str(self.cwd)}

    def turn(self, native=None):
        target = self.target(native)
        return {"prompt": target["session_id"], "target_agent_id": target["agent_id"], "provider": "codex",
                "session_id": target["session_id"], "cwd": target["cwd"], "turn_options": {"mode": "resume"},
                "require_online": True, "remote_target": target}

    async def directory(self, refresh=True):
        response = await self.http.get("/v1/remote-sessions", params={"refresh": str(refresh).lower()})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def history(self, key="old", confirmed=True, status="done", execution="idle"):
        task = {"target_agent": self.agent.agent_id, "provider": "codex", "session_id": self.ids[0],
                "remote_target": self.target(), "status": status, "execution_status": execution,
                "connection_id": self.agent.connection_id, "execution_revision": hub.next_receipt_revision()}
        if status in {"done", "failed"}: task["result"] = {"cleanup_confirmed": confirmed}
        hub.tasks[key] = task
        return task

    def status(self, directory):
        return next(row["execution_status"] for row in directory["sessions"] if row["session_id"] == self.ids[0])

    async def test_two_http_refreshes_share_scan_and_committed_directory(self):
        self.hold_scan()
        first = asyncio.create_task(self.directory()); second = asyncio.create_task(self.directory())
        await self.until(self.scan_started.is_set); await asyncio.sleep(.1)
        during = await self.directory(False)
        self.assertEqual(self.scan_calls, 1)
        self.assertEqual(during["agents"][0]["catalog_status"], "ready")
        self.assertEqual(during["agents"][0]["refresh_status"], "scanning")
        self.assertEqual(len(during["sessions"]), 2)
        hub.validate_remote_target(self.target())  # Delivery while a refresh is in flight.
        self.gate.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual(a["agents"][0]["status"], "ready")
        self.assertEqual(a["agents"][0]["revision"], b["agents"][0]["revision"])
        self.assertEqual(a["sessions"], b["sessions"])

    async def test_two_valid_turns_refresh_interleave_and_one_waiter_cancels(self):
        self.hold_scan()
        cancelled = asyncio.create_task(hub.refresh_remote_catalog(self.agent))
        await self.until(self.scan_started.is_set)
        turns = [asyncio.create_task(self.http.post("/v1/turns", json=self.turn(native))) for native in self.ids]
        directory = asyncio.create_task(self.directory())
        await asyncio.sleep(.1); cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError): await cancelled
        self.assertFalse(self.agent.refresh_task.cancelled())
        self.assertEqual(self.scan_calls, 1)
        self.gate.set()
        responses = await asyncio.gather(*turns)
        await directory
        for response in responses:
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotEqual(response.json()["task"]["status"], "waiting_for_agent")
        await self.until(lambda: len(self.executed) == 2 and all(task["status"] == "done" for task in hub.tasks.values()))
        self.assertEqual({row["session_id"] for row in self.executed}, set(self.ids))
        self.assertTrue(all(row["cwd"] == str(self.cwd) for row in self.executed))

    async def test_waiter_timeout_does_not_cancel_shared_scan_or_empty_valid_catalog(self):
        self.hold_scan()
        survivor = asyncio.create_task(self.directory())
        await self.until(self.scan_started.is_set)
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(hub.refresh_remote_catalog(self.agent), .05)
        self.assertFalse(self.agent.refresh_task.done())
        self.assertEqual(len((await self.directory(False))["sessions"]), 2)
        self.gate.set()
        self.assertEqual((await survivor)["agents"][0]["status"], "ready")

    async def test_scan_io_failure_preserves_catalog_but_rejects_fresh_selected_turn(self):
        original = Path.open
        def denied(path, *args, **kwargs):
            if path.parent == self.sessions: raise PermissionError("fixture scan read denied")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", denied):
            failed = await self.directory()
            self.assertEqual(failed["agents"][0]["status"], "failed")
            self.assertEqual(failed["agents"][0]["catalog_status"], "ready")
            self.assertEqual(len(failed["sessions"]), 2)
            response = await self.http.post("/v1/turns", json=self.turn())
            self.assertEqual(response.status_code, 409); self.assertEqual(self.executed, [])
        self.assertEqual((await self.directory())["agents"][0]["status"], "ready")

    async def test_completed_snapshots_survive_following_refresh_and_real_invalidation(self):
        first = await hub.refresh_remote_catalog(self.agent)
        self.hold_scan()
        second = asyncio.create_task(hub.refresh_remote_catalog(self.agent))
        await self.until(self.scan_started.is_set)
        self.assertEqual(first.status, "ready"); self.assertEqual(len(first.sessions), 2)
        hub.validate_remote_target(self.target(), first)
        for path in self.sessions.glob("*.jsonl"): path.unlink()
        self.gate.set(); empty = await second
        self.assertEqual(empty.status, "empty"); self.assertEqual(empty.sessions, ())
        self.assertEqual(len(first.sessions), 2)
        with self.assertRaises(hub.HTTPException): hub.validate_remote_target(self.target(), first)
        response = await self.http.post("/v1/turns", json=self.turn())
        self.assertEqual(response.status_code, 409); self.assertEqual(self.executed, [])

    async def test_session_removed_during_shared_send_refresh_is_rejected(self):
        self.hold_scan()
        refresh = asyncio.create_task(self.directory())
        turn = asyncio.create_task(self.http.post("/v1/turns", json=self.turn()))
        await self.until(self.scan_started.is_set)
        (self.sessions / f"{self.ids[0]}.jsonl").unlink()
        self.gate.set()
        result, response = await asyncio.gather(refresh, turn)
        self.assertEqual(len(result["sessions"]), 1); self.assertEqual(response.status_code, 409)
        self.assertEqual(self.executed, []); self.assertEqual(hub.tasks, {})

    async def test_real_disconnect_during_refresh_rejects_selected_turn(self):
        self.hold_scan()
        refresh = asyncio.create_task(self.directory())
        turn = asyncio.create_task(self.http.post("/v1/turns", json=self.turn()))
        await self.until(self.scan_started.is_set)
        pending = list(self.bridges[0].pending_tasks)
        self.connections[0].cancel(); await asyncio.gather(self.connections[0], return_exceptions=True)
        await self.until(lambda: not hub.agents)
        self.gate.set()
        result, response = await asyncio.gather(refresh, turn)
        await asyncio.gather(*pending, return_exceptions=True)
        self.assertEqual(result["status"], "disconnected"); self.assertEqual(response.status_code, 409)
        self.assertEqual(self.executed, [])

    async def test_live_lock_from_legacy_or_other_hub_beats_old_station_completion(self):
        self.history()
        # Lock is shared by Bridge processes/Hubs, including old no-target calls.
        lock = SessionLock("codex", self.ids[0]); self.assertTrue(lock.try_acquire())
        try:
            lock.write({"status": "running"})
            self.assertEqual(self.status(await self.directory()), "running")
            self.history("waiting", status="sent", execution="waiting")
            self.assertEqual(self.status(await self.directory()), "running")
            lock.write({"status": "cleanup-unconfirmed"})
            self.assertEqual(self.status(await self.directory()), "cleanup-unconfirmed")
        finally: lock.close()

    async def test_new_idle_scan_clears_old_unconfirmed_but_new_failure_beats_old_scan(self):
        self.history(confirmed=False, status="failed")
        lock = SessionLock("codex", self.ids[0]); self.assertTrue(lock.try_acquire())
        lock.write({"version": 2, "status": "idle", "phase": "cleaned", "exit_proof": True}); lock.close()
        recovered = await self.directory()
        self.assertEqual(self.status(recovered), "idle")
        self.history("new-failure", confirmed=False, status="failed")
        self.assertEqual(self.status(await self.directory(False)), "cleanup-unconfirmed")
        self.assertEqual(self.status(await self.directory()), "idle")

    async def test_other_bridge_live_lock_and_current_task_state_priority(self):
        await self.connect("fixture-agent-2")
        self.history()
        lock = SessionLock("codex", self.ids[0]); self.assertTrue(lock.try_acquire())
        try:
            lock.write({"status": "running"})
            directory = await self.directory()
            self.assertEqual({row["execution_status"] for row in directory["sessions"] if row["session_id"] == self.ids[0]}, {"running"})
            original = self.bridges[1]._scan_sessions
            def legacy_scan():
                result = original()
                for row in result["sessions"]: row.pop("execution_status", None)
                return result
            with patch.object(self.bridges[1], "_scan_sessions", legacy_scan):
                await hub.refresh_remote_catalog(hub.agents["fixture-agent-2"])
                self.assertEqual(self.status(await self.directory(False)), "running")
            self.history("active", status="acked", execution="running")
            self.history("waiting", status="sent", execution="waiting")
            lock.write({"status": "idle"})
            self.assertEqual(self.status(await self.directory()), "running")
            hub.tasks["active"]["execution_status"] = "cleanup-unconfirmed"
            hub.tasks["active"]["execution_revision"] = hub.next_receipt_revision()
            self.assertEqual(self.status(await self.directory(False)), "cleanup-unconfirmed")
            lock.write({"version": 2, "status": "idle", "phase": "cleaned", "exit_proof": True}); lock.close()
            self.assertEqual(self.status(await self.directory()), "waiting")
        finally: lock.close()


if __name__ == "__main__": unittest.main()
