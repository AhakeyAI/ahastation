"""Loopback Hub + actual Bridges for Station integration tests. Never invokes a CLI."""
import asyncio
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "device"))
import uvicorn
import desktop_control_panel as panel
import device_hub as hub
import desktop_agent
from desktop_agent import DesktopBridge


async def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        os.environ["POCKET_VIBE_STATE_DIR"] = str(root / "state")
        hub.RUNTIME_DIR = root
        hub.EVENT_LOG = root / "events.jsonl"
        desktop_agent.OUTBOX = root / "outbox.jsonl"
        hub.DEV_TOKEN = "fixture-bridge-token"
        hub.TOOL_TOKEN = "fixture-tool-token"
        hub.router.base_url = ""  # Always use the existing heuristic router.
        bridges = []
        for provider in ("codex", "claude"):
            sessions = root / provider
            sessions.mkdir()
            ids = ("native-session-a", "native-session-b") if provider == "codex" else ("native-session-c",)
            for session_id in ids:
                cwd = root / f"project-{session_id}"
                cwd.mkdir()
                row = {"type": "session_meta", "payload": {"cwd": str(cwd)}} if provider == "codex" else {
                    "type": "user", "cwd": str(cwd), "message": {"role": "user", "content": "Claude fixture"},
                }
                (sessions / f"{session_id}.jsonl").write_text(json.dumps(row), encoding="utf-8")
            config = root / f"{provider}.json"
            config.write_text(json.dumps({"command": ["never-run"], "capabilities": [f"{provider}.exec"]}), encoding="utf-8")
            bridges.append((provider, config))
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(hub.app, log_level="error", lifespan="on"))
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        while not server.started:
            await asyncio.sleep(.01)
        bridge_tasks = []
        with patch.object(panel, "session_roots", side_effect=lambda provider: [root / provider]), patch.object(panel, "load_codex_thread_index", return_value={}):
            for provider, config in bridges:
                bridge = DesktopBridge(f"ws://127.0.0.1:{port}/ws/desktop", hub.DEV_TOKEN, f"fixture-{provider}", local_agent_config=str(config))
                if "--slow-scan" in sys.argv:
                    def scan(original=bridge._scan_sessions):
                        time.sleep(.15)
                        return original()
                    bridge._scan_sessions = scan
                async def execute(msg, on_state=None, agent_id=bridge.agent_id):
                    payload = msg["payload"]
                    if "fail execution" in payload["objective"]:
                        return {"ok": False, "error": "fixture execution failed"}
                    # Echo references only; the Station asserts exact dispatch.
                    result = {key: payload.get(key) for key in ("provider", "session_id", "cwd", "turn_options", "objective")}
                    result["agent_id"] = agent_id
                    return {"ok": True, "json": {"last_message": json.dumps(result)}}
                bridge.local_agent.run = execute
                bridge_tasks.append(asyncio.create_task(bridge._connect_once()))
            for _ in range(500):
                if len(hub.agents) == 2 and all(agent.catalog_status == "ready" for agent in hub.agents.values()):
                    break
                await asyncio.sleep(.01)
            else:
                raise RuntimeError("fixture Bridges did not become ready")
            print(json.dumps({"ready": True, "url": f"http://127.0.0.1:{port}"}), flush=True)
            while True:
                command = (await asyncio.to_thread(sys.stdin.readline)).strip()
                if command == "disconnect":
                    for agent in list(hub.agents.values()):
                        await agent.websocket.close()
                    await asyncio.sleep(.05)
                    print(json.dumps({"disconnected": True}), flush=True)
                else:
                    break
            for task in bridge_tasks:
                task.cancel()
            await asyncio.gather(*bridge_tasks, return_exceptions=True)
        server.should_exit = True
        await server_task
        listener.close()


if __name__ == "__main__":
    asyncio.run(main())
