from __future__ import annotations

import asyncio
import json
import os
import copy
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from protocol import envelope, new_id, now_iso
from qwen_router import QwenDecisionRouter


ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
RUNTIME_DIR = ROOT / "runtime"
EVENT_LOG = RUNTIME_DIR / "events.jsonl"
DEV_TOKEN = os.getenv("POCKET_VIBE_TOKEN", "dev-token")
TOOL_TOKEN = os.getenv("POCKET_VIBE_TOOL_TOKEN", "dev-tool-token")


@asynccontextmanager
async def lifespan(_: FastAPI):
    RUNTIME_DIR.mkdir(exist_ok=True)
    yield


app = FastAPI(title="Pocket Vibe Device Hub", version="0.1", lifespan=lifespan)
router = QwenDecisionRouter()


@dataclass(frozen=True)
class CatalogSnapshot:
    status: str
    error: str
    scanned_at: str
    revision: int
    sessions: tuple[dict[str, Any], ...]
    refresh_status: str
    refresh_error: str


@dataclass
class DesktopAgent:
    agent_id: str
    websocket: WebSocket
    display_name: str = ""
    platform: str = "unknown"
    capabilities: list[str] = field(default_factory=list)
    connected_at: str = field(default_factory=now_iso)
    last_seen: str = field(default_factory=now_iso)
    status: str = "idle"
    active_task_id: str | None = None
    seq: int = 0
    computer_name: str = ""
    device_id: str = ""
    remote_sessions: list[dict[str, Any]] = field(default_factory=list)
    catalog_status: str = "unsupported"
    catalog_error: str = "Bridge 不支持会话目录，请更新并重启 Bridge"
    catalog_scanned_at: str = ""
    catalog_request_id: str = ""
    catalog_event: asyncio.Event = field(default_factory=asyncio.Event)
    catalog_revision: int = 0
    refresh_status: str = "idle"
    refresh_error: str = ""
    refresh_task: asyncio.Task[CatalogSnapshot] | None = None
    refresh_result: CatalogSnapshot | None = None
    connection_id: str = field(default_factory=lambda: new_id("connection"))

    async def send(self, msg_type: str, payload: dict[str, Any], task_id: str | None = None) -> dict[str, Any]:
        self.seq += 1
        msg = envelope(msg_type, payload, task_id=task_id, seq=self.seq)
        await self.websocket.send_json(msg)
        await append_event("hub.send", {"agent_id": self.agent_id, "message": msg})
        return msg

    def snapshot(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "display_name": self.display_name or self.agent_id,
            "platform": self.platform,
            "capabilities": self.capabilities,
            "status": self.status,
            "active_task_id": self.active_task_id,
            "connected_at": self.connected_at,
            "last_seen": self.last_seen,
        }


agents: dict[str, DesktopAgent] = {}
gui_clients: set[WebSocket] = set()
recent_events: list[dict[str, Any]] = []
tasks: dict[str, dict[str, Any]] = {}
receipt_revision = 0


def next_receipt_revision() -> int:
    # Hub-local ordering, not timestamps from different computers.
    global receipt_revision
    receipt_revision += 1
    return receipt_revision


def catalog_snapshot(agent: DesktopAgent) -> CatalogSnapshot:
    return CatalogSnapshot(agent.catalog_status, agent.catalog_error, agent.catalog_scanned_at,
                           agent.catalog_revision, tuple(copy.deepcopy(agent.remote_sessions)),
                           agent.refresh_status, agent.refresh_error)


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/styles.css")
async def styles() -> FileResponse:
    return FileResponse(WEB_DIR / "styles.css")


@app.get("/app.js")
async def app_js() -> FileResponse:
    return FileResponse(WEB_DIR / "app.js")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "time": now_iso(),
        "agents": [agent.snapshot() for agent in agents.values()],
        "qwen_mode": "openai-compatible" if router.base_url else "heuristic-fallback",
    }


@app.get("/api/agents")
async def api_agents(request: Request) -> dict[str, Any]:
    require_tool_token(request)
    return {
        "ok": True,
        "time": now_iso(),
        "count": len(agents),
        "agents": [agent.snapshot() for agent in agents.values()],
    }


@app.get("/api/agents/{agent_id}")
async def api_agent(agent_id: str, request: Request) -> dict[str, Any]:
    require_tool_token(request)
    agent = agents.get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent is not online: {agent_id}")
    return {"ok": True, "agent": agent.snapshot()}


@app.post("/api/tasks")
async def api_create_task(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    require_tool_token(request)
    objective = str(payload.get("objective", "")).strip()
    requested_level = str(payload.get("thinking_level", "auto")).strip() or "auto"
    requested_agent_id = str(payload.get("target_agent_id") or payload.get("agent_id") or "").strip()
    if not objective:
        raise HTTPException(status_code=400, detail="objective is required")
    task = await create_and_route_task(
        objective,
        requested_level,
        requested_agent_id,
        source="api",
    )
    return {"ok": True, "task": task}


@app.get("/v1/agents")
async def v1_agents(request: Request) -> dict[str, Any]:
    require_tool_token(request)
    return {
        "ok": True,
        "time": now_iso(),
        "count": len(agents),
        "agents": [agent.snapshot() for agent in agents.values()],
    }


@app.get("/v1/sessions")
async def v1_sessions(request: Request, provider: str = "") -> dict[str, Any]:
    require_tool_token(request)
    provider = provider.strip().lower()
    sessions = []
    for agent in agents.values():
        if provider and not agent_matches_provider(agent, provider):
            continue
        sessions.append({
            "session_id": agent.agent_id,
            "provider": detect_provider(agent),
            "display_name": agent.display_name or agent.agent_id,
            "status": agent.status,
            "capabilities": agent.capabilities,
            "agent": agent.snapshot(),
            "note": "For provider-native resume, start a bridge with a config that pins the Codex/Claude session id, or pass session_id to /v1/turns.",
        })
    return {"ok": True, "time": now_iso(), "count": len(sessions), "sessions": sessions}


async def refresh_remote_catalog(agent: DesktopAgent) -> CatalogSnapshot:
    if "remote.sessions" not in agent.capabilities:
        return catalog_snapshot(agent)
    if agent.refresh_task is None or agent.refresh_task.done():
        agent.refresh_task = asyncio.create_task(_refresh_remote_catalog(agent))
    # One cancelled HTTP request must not cancel the shared WebSocket scan.
    return await asyncio.shield(agent.refresh_task)


async def _refresh_remote_catalog(agent: DesktopAgent) -> CatalogSnapshot:
    agent.refresh_status = "scanning"
    agent.refresh_error = ""
    agent.refresh_result = None
    agent.catalog_event.clear()
    agent.catalog_request_id = new_id("catalog")
    try:
        await agent.websocket.send_json(envelope("refresh_sessions", {}, msg_id=agent.catalog_request_id))
        await asyncio.wait_for(agent.catalog_event.wait(), timeout=10)
        if agents.get(agent.agent_id) is not agent:
            raise ConnectionError("Bridge disconnected during refresh")
        if agent.refresh_result is None:
            raise ConnectionError("Bridge did not return a completed catalogue")
        return agent.refresh_result
    except Exception as exc:
        agent.refresh_status = "failed"
        agent.refresh_error = f"刷新会话目录失败：{type(exc).__name__}: {exc}"
        return catalog_snapshot(agent)


def validate_remote_target(target: Any, snapshot: CatalogSnapshot | None = None, *, require_catalog: bool = True) -> DesktopAgent:
    if not isinstance(target, dict) or any(not isinstance(target.get(key), str) or not target[key]
                                          for key in ("agent_id", "device_id", "provider", "session_id", "cwd")):
        raise HTTPException(400, "Invalid remote target reference (refresh the session directory)")
    agent = agents.get(target["agent_id"])
    if not agent:
        raise HTTPException(409, "Selected remote Agent is offline; task was not queued")
    if agent.device_id != target["device_id"] or detect_provider(agent) != target["provider"]:
        raise HTTPException(409, "Selected remote device/provider does not match the saved reference")
    if not require_catalog:
        return agent
    if snapshot:
        if snapshot.refresh_status not in {"ready", "empty"}:
            raise HTTPException(409, snapshot.refresh_error or "Remote catalogue refresh failed")
        if snapshot.status not in {"ready", "empty"} or not any(
            row["session_id"] == target["session_id"] and row["cwd"] == target["cwd"] and row.get("available") is not False
            for row in snapshot.sessions):
            raise HTTPException(409, "Selected native session or project directory is no longer valid")
    # Check the latest committed catalogue too. Another completed refresh may
    # have removed the session since this request's snapshot; an in-flight
    # refresh leaves this committed state intact.
    if agent.catalog_status not in {"ready", "empty"}:
        raise HTTPException(409, agent.catalog_error or "Remote session directory is not ready")
    if not any(row["session_id"] == target["session_id"] and row["cwd"] == target["cwd"] and row.get("available") is not False
               for row in agent.remote_sessions):
        raise HTTPException(409, "Selected native session or project directory is no longer valid")
    return agent


def session_execution_status(agent: DesktopAgent, item: dict, catalogs: list[tuple[DesktopAgent, CatalogSnapshot]] | None = None) -> str:
    related = []
    for task in tasks.values():
        entry = agents.get(task.get("target_agent"))
        device = task.get("remote_target", {}).get("device_id") or (entry.device_id if entry else "")
        if device == agent.device_id and task.get("provider") == item["provider"] and task.get("session_id") == item["session_id"]:
            related.append(task)
    current = [task for task in related if task.get("status") not in {"done", "failed"}
               and (entry := agents.get(task.get("target_agent")))
               and task.get("connection_id", entry.connection_id) == entry.connection_id]
    readings = [(snap.revision, row.get("execution_status", "unknown"))
                for entry, snap in (catalogs if catalogs is not None else [(agent, catalog_snapshot(agent))])
                if entry.device_id == agent.device_id for row in snap.sessions
                if row["provider"] == item["provider"] and row["session_id"] == item["session_id"]]
    reliable = [row for row in readings if row[1] != "unknown"]
    scan_revision, live = max(reliable or readings, default=(0, item.get("execution_status", "unknown")), key=lambda row: row[0])
    active = {task.get("execution_status") for task in current
              if not (task.get("execution_status") == "cleanup-unconfirmed" and live == "idle"
                      and scan_revision > task.get("execution_revision", 0))}
    # Current tasks and live locks beat historical completion. Running beats
    # waiting when one Bridge owns the lock and another is queued.
    for state in ("cleanup-unconfirmed", "running", "waiting"):
        if state in active or live == state:
            return state
    history = max(related, key=lambda task: task.get("execution_revision", 0), default={})
    if live == "idle":
        if history.get("execution_revision", 0) > scan_revision and history.get("result", {}).get("cleanup_confirmed") is False:
            return "cleanup-unconfirmed"
        return "idle"
    confirmed = history.get("result", {}).get("cleanup_confirmed")
    return "idle" if confirmed is True else "cleanup-unconfirmed" if confirmed is False else "unknown"


@app.get("/v1/remote-sessions")
async def v1_remote_sessions(request: Request, refresh: bool = False) -> dict[str, Any]:
    require_tool_token(request)
    return await remote_directory(list(agents.values()), refresh)


async def remote_directory(connected: list[DesktopAgent], refresh: bool = False) -> dict[str, Any]:
    """Serialize only the caller-authorized connections, retaining shared scans."""
    snapshots = await asyncio.gather(*(refresh_remote_catalog(agent) for agent in connected)) if refresh else [catalog_snapshot(agent) for agent in connected]
    catalogs = [(agent, snap) for agent, snap in zip(connected, snapshots) if agents.get(agent.agent_id) is agent]
    directories = [{
        "agent_id": agent.agent_id,
        "device_id": agent.device_id,
        "computer_name": agent.computer_name or agent.agent_id,
        "display_name": agent.display_name or agent.agent_id,
        "provider": detect_provider(agent),
        "status": snap.status if snap.refresh_status != "failed" else "failed",
        "error": snap.refresh_error or snap.error,
        "catalog_status": snap.status,
        "refresh_status": snap.refresh_status,
        "revision": snap.revision,
        "scanned_at": snap.scanned_at,
    } for agent, snap in catalogs]
    sessions = [{
        **item,
        "agent_id": agent.agent_id,
        "device_id": agent.device_id,
        "computer_name": agent.computer_name or agent.agent_id,
        "execution_status": session_execution_status(agent, item, catalogs),
        "native_client_status": "unknown",
    } for agent, snap in catalogs if snap.status in {"ready", "empty"} for item in snap.sessions]
    return {"ok": True, "status": "connected" if catalogs else "disconnected",
            "agents": directories, "sessions": sessions, "count": len(sessions)}


@app.post("/v1/turns")
async def v1_create_turn(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    require_tool_token(request)
    objective = str(payload.get("prompt") or payload.get("objective") or "").strip()
    if not objective:
        raise HTTPException(status_code=400, detail="prompt or objective is required")

    provider = str(payload.get("provider", "")).strip().lower()
    session_id = str(payload.get("session_id", "")).strip()
    requested_agent_id = str(payload.get("target_agent_id") or payload.get("agent_id") or "").strip()
    if not requested_agent_id and session_id in agents:
        requested_agent_id = session_id
    if not requested_agent_id and provider:
        match = resolve_agent_by_provider(provider)
        if match:
            requested_agent_id = match.agent_id

    extra_payload = {
        "provider": provider,
        "session_id": session_id,
        "cwd": str(payload.get("cwd", "")).strip(),
        "turn_options": payload.get("turn_options", {}) if isinstance(payload.get("turn_options", {}), dict) else {},
        "metadata": payload.get("metadata", {}) if isinstance(payload.get("metadata", {}), dict) else {},
    }
    if payload.get("require_online") is True:
        target = payload.get("remote_target")
        agent = validate_remote_target(target, require_catalog=False)
        refreshed = await refresh_remote_catalog(agent)
        if agents.get(agent.agent_id) is not agent:
            raise HTTPException(409, "Selected Bridge disconnected during refresh")
        validate_remote_target(target, refreshed)
        options = extra_payload["turn_options"]
        if (requested_agent_id != target["agent_id"] or provider != target["provider"]
            or session_id != target["session_id"] or extra_payload["cwd"] != target["cwd"]
            or options.get("session_id", session_id) != session_id
            or options.get("cwd", target["cwd"]) != target["cwd"]
            or options.get("mode", "resume") != "resume"):
            raise HTTPException(400, "Remote target does not match execution parameters")
        extra_payload.update(require_online=True, remote_target={key: target[key] for key in
                              ("agent_id", "device_id", "provider", "session_id", "cwd")})
    task = await create_and_route_task(
        objective,
        str(payload.get("thinking_level", "auto")).strip() or "auto",
        requested_agent_id,
        source="v1",
        extra_payload=extra_payload,
    )
    return {"ok": True, "turn_id": task["task_id"], "task": task}


@app.get("/v1/turns/{turn_id}")
async def v1_get_turn(turn_id: str, request: Request) -> dict[str, Any]:
    require_tool_token(request)
    task = tasks.get(turn_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"Turn is not found: {turn_id}")
    return {"ok": True, "turn_id": turn_id, "task": task}


@app.websocket("/ws/gui")
async def ws_gui(websocket: WebSocket) -> None:
    await websocket.accept()
    gui_clients.add(websocket)
    await websocket.send_json(envelope("snapshot", await snapshot()))
    try:
        while True:
            msg = await websocket.receive_json()
            await handle_gui_message(websocket, msg)
    except WebSocketDisconnect:
        gui_clients.discard(websocket)


@app.websocket("/ws/desktop")
async def ws_desktop(websocket: WebSocket, token: str = "", agent_id: str = "") -> None:
    if token != DEV_TOKEN:
        await websocket.close(code=4401, reason="bad token")
        return
    await websocket.accept()
    assigned_id = agent_id or new_id("desktop")
    if assigned_id in agents:
        await append_event("agent.duplicate_rejected", {"agent_id": assigned_id})
        await websocket.close(code=4409, reason="agent id already connected")
        return
    desktop = DesktopAgent(agent_id=assigned_id, websocket=websocket, display_name=default_agent_name(assigned_id))
    agents[assigned_id] = desktop
    await append_event("agent.connected", {"agent_id": assigned_id})
    await broadcast("agent_connected", desktop.snapshot())

    heartbeat = asyncio.create_task(heartbeat_loop(desktop))
    try:
        while True:
            msg = await websocket.receive_json()
            desktop.last_seen = now_iso()
            await handle_desktop_message(desktop, msg)
    except WebSocketDisconnect:
        pass
    finally:
        heartbeat.cancel()
        agents.pop(assigned_id, None)
        desktop.catalog_event.set()  # Wake shared refresh waiters on real disconnect.
        await append_event("agent.disconnected", {"agent_id": assigned_id})
        await broadcast("agent_disconnected", {"agent_id": assigned_id})


async def heartbeat_loop(agent: DesktopAgent) -> None:
    while True:
        await asyncio.sleep(8)
        try:
            await agent.send("heartbeat", {"server_time": now_iso()})
        except Exception:
            return


async def handle_gui_message(websocket: WebSocket, msg: dict[str, Any]) -> None:
    msg_type = msg.get("type")
    payload = msg.get("payload", {})
    if msg_type == "submit_task":
        objective = str(payload.get("objective", "")).strip()
        requested_level = str(payload.get("thinking_level", "auto"))
        requested_agent_id = str(payload.get("target_agent_id", "")).strip()
        if not objective:
            await websocket.send_json(envelope("error", {"message": "Objective is empty"}))
            return

        turn_options = payload.get("turn_options", {})
        if not isinstance(turn_options, dict):
            turn_options = {}
        metadata = payload.get("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        extra_payload = {
            "provider": str(payload.get("provider", "")).strip().lower(),
            "session_id": str(payload.get("session_id", "")).strip(),
            "cwd": str(payload.get("cwd", "")).strip(),
            "turn_options": turn_options,
            "metadata": metadata,
        }

        await create_and_route_task(
            objective,
            requested_level,
            requested_agent_id,
            source="gui",
            extra_payload=extra_payload,
        )

    elif msg_type == "refresh":
        await websocket.send_json(envelope("snapshot", await snapshot()))
    elif msg_type == "rename_agent":
        agent_id = str(payload.get("agent_id", "")).strip()
        display_name = str(payload.get("display_name", "")).strip()[:32]
        if agent_id in agents and display_name:
            agents[agent_id].display_name = display_name
            await append_event("agent.renamed", {"agent_id": agent_id, "display_name": display_name})
            await broadcast("agent_updated", agents[agent_id].snapshot())


async def handle_desktop_message(agent: DesktopAgent, msg: dict[str, Any]) -> None:
    msg_type = msg.get("type")
    payload = msg.get("payload", {})
    if msg_type == "hello":
        agent.platform = str(payload.get("platform", "unknown"))
        agent.display_name = str(payload.get("display_name") or agent.display_name or default_agent_name(agent.agent_id))
        agent.capabilities = [str(item) for item in payload.get("capabilities", [])]
        agent.computer_name = str(payload.get("hostname") or agent.agent_id)[:160]
        agent.device_id = str(payload.get("device_id", ""))[:256]
        if "remote.sessions" in agent.capabilities:
            agent.catalog_status = "scanning"
            agent.catalog_error = ""
        await append_event("agent.hello", {"agent_id": agent.agent_id, "payload": payload})
        await broadcast("agent_updated", agent.snapshot())
        await dispatch_waiting_tasks(agent)
    elif msg_type == "session_catalog":
        request_id = str(payload.get("request_id", ""))
        if agent.catalog_request_id and request_id != agent.catalog_request_id:
            return
        status = payload.get("status")
        agent.refresh_status = status if status in {"ready", "empty", "failed", "unsupported"} else "failed"
        agent.refresh_error = str(payload.get("error", ""))[:500]
        rows = []
        seen: set[tuple[str, str]] = set()
        items = payload.get("sessions", [])
        for item in items[:120] if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            provider = item.get("provider")
            session_id = item.get("session_id")
            if provider != detect_provider(agent) or not isinstance(session_id, str) or not session_id or len(session_id) > 256:
                continue
            key = (provider, session_id)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "provider": provider, "session_id": session_id,
                "title": str(item.get("title") or session_id)[:160],
                "cwd": str(item.get("cwd", ""))[:4096],
                "available": item.get("available") is not False,
                "error": str(item.get("error", ""))[:500],
                "execution_status": item.get("execution_status") if item.get("execution_status") in
                    {"idle", "running", "waiting", "cleanup-unconfirmed"} else "unknown",
            })
        if status in {"ready", "empty"}:
            agent.catalog_status = status
            agent.catalog_error = ""
            agent.catalog_scanned_at = str(payload.get("scanned_at", ""))[:64]
            agent.remote_sessions = rows
            agent.catalog_revision = next_receipt_revision()
        elif agent.catalog_status not in {"ready", "empty"}:
            agent.catalog_status = agent.refresh_status
            agent.catalog_error = agent.refresh_error
        agent.refresh_result = catalog_snapshot(agent)
        agent.catalog_event.set()
    elif msg_type == "task_state":
        task = tasks.get(msg.get("task_id"))
        if task and task.get("target_agent") == agent.agent_id and payload.get("status") in {
            "waiting", "running", "idle", "cleanup-unconfirmed"}:
            task["execution_status"] = payload["status"]
            task["execution_revision"] = next_receipt_revision()
    elif msg_type == "ack":
        task_id = msg.get("task_id")
        if task_id and task_id in tasks:
            tasks[task_id]["status"] = "acked"
            tasks[task_id]["ack_at"] = now_iso()
        await append_event("agent.ack", {"agent_id": agent.agent_id, "message": msg})
        await broadcast("task_acked", {"agent_id": agent.agent_id, "task_id": task_id, "ack_of": msg.get("ack_of")})
    elif msg_type == "result":
        task_id = msg.get("task_id")
        if task_id in tasks and tasks[task_id].get("target_agent") != agent.agent_id:
            return
        if task_id and task_id in tasks:
            succeeded = payload.get("ok") is not False
            tasks[task_id]["status"] = "done" if succeeded else "failed"
            tasks[task_id]["result"] = payload
            if not succeeded:
                tasks[task_id]["error"] = payload.get("error") or payload.get("stderr") or "Agent execution failed"
            tasks[task_id]["done_at"] = now_iso()
            target_agent_id = tasks[task_id].get("target_agent")
            if target_agent_id in agents:
                agents[target_agent_id].status = "idle" if payload.get("cleanup_confirmed") is not False else "unknown"
                agents[target_agent_id].active_task_id = None
            tasks[task_id]["execution_status"] = "idle" if payload.get("cleanup_confirmed") is not False else "cleanup-unconfirmed"
            tasks[task_id]["execution_revision"] = next_receipt_revision()
        await append_event("agent.result", {"agent_id": agent.agent_id, "message": msg})
        await broadcast("task_result", {"agent_id": agent.agent_id, "task_id": task_id, "result": payload})
    elif msg_type == "pong":
        await append_event("agent.pong", {"agent_id": agent.agent_id})
    else:
        await append_event("agent.message", {"agent_id": agent.agent_id, "message": msg})
        await broadcast("agent_message", {"agent_id": agent.agent_id, "message": msg})


def detect_provider(agent: DesktopAgent) -> str:
    caps = set(agent.capabilities)
    if any(cap.startswith("codex.") for cap in caps):
        return "codex"
    if any(cap.startswith("claude.") for cap in caps):
        return "claude"
    return "local"


def agent_matches_provider(agent: DesktopAgent, provider: str) -> bool:
    if not provider:
        return True
    return detect_provider(agent) == provider


def resolve_agent_by_provider(provider: str) -> DesktopAgent | None:
    provider = provider.strip().lower()
    for agent in agents.values():
        if agent_matches_provider(agent, provider):
            return agent
    return None


def resolve_agent(decision: dict[str, Any], requested_agent_id: str = "") -> DesktopAgent | None:
    if requested_agent_id:
        return agents.get(requested_agent_id)

    target_capability = decision.get("target_capability")
    for agent in agents.values():
        if target_capability in agent.capabilities:
            return agent
    return next(iter(agents.values()), None)


async def create_and_route_task(
    objective: str,
    requested_level: str = "auto",
    requested_agent_id: str = "",
    source: str = "unknown",
    extra_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    decision = await router.decide(objective, requested_level, [a.snapshot() for a in agents.values()])
    if extra_payload and extra_payload.get("require_online"):
        validate_remote_target(extra_payload["remote_target"])  # Recheck after asynchronous routing.
    task_id = new_id("task")
    task: dict[str, Any] = {
        "task_id": task_id,
        "objective": objective,
        "decision": decision.as_dict(),
        "status": "queued",
        "source": source,
        "created_at": now_iso(),
    }
    if requested_agent_id:
        task["requested_agent_id"] = requested_agent_id
    if extra_payload:
        for key, value in extra_payload.items():
            if value not in (None, "", {}):
                task[key] = value
    tasks[task_id] = task
    await append_event("task.created", task)
    await broadcast("task_created", task)

    target = resolve_agent(decision.as_dict(), requested_agent_id) if agents else None
    if target is None:
        if task.get("require_online"):
            task.update(status="failed", error="Selected Agent disconnected; task was not queued")
            return task
        task["status"] = "waiting_for_agent"
        await broadcast("task_waiting", task)
        return task

    try:
        await send_task_to_agent(task, target)
    except Exception as exc:
        if not task.get("require_online"):
            raise
        # Delivery may be uncertain. Never retry this native turn after reconnect.
        task.update(status="failed", error=f"Remote delivery failed; do not retry automatically: {exc}")
    return task


async def send_task_to_agent(task: dict[str, Any], agent: DesktopAgent, resumed_from_waiting_queue: bool = False) -> None:
    if task.get("require_online"):
        if validate_remote_target(task["remote_target"]) is not agent:
            raise HTTPException(409, "Selected Bridge connection changed")
    task["status"] = "sent"
    task["execution_status"] = "waiting"
    task["execution_revision"] = next_receipt_revision()
    task["connection_id"] = agent.connection_id
    task["target_agent"] = agent.agent_id
    agent.status = "working"
    agent.active_task_id = task["task_id"]
    payload = {
        "objective": task["objective"],
        "decision": task.get("decision", {}),
        "safe_mode": True,
    }
    for key in ("provider", "session_id", "cwd", "turn_options", "metadata", "remote_target"):
        if key in task:
            payload[key] = task[key]
    if resumed_from_waiting_queue:
        payload["resumed_from_waiting_queue"] = True
    sent = await agent.send("task", payload, task_id=task["task_id"])
    task["last_message_id"] = sent["msg_id"]
    await broadcast("task_sent", task)


async def dispatch_waiting_tasks(agent: DesktopAgent) -> None:
    for task in list(tasks.values()):
        if task.get("status") != "waiting_for_agent":
            continue
        if task.get("require_online"):
            continue
        decision = task.get("decision", {})
        requested_agent_id = str(task.get("requested_agent_id", "")).strip()
        if requested_agent_id and agent.agent_id != requested_agent_id:
            continue
        capability = decision.get("target_capability")
        if not requested_agent_id and capability and agent.capabilities and capability not in agent.capabilities:
            continue
        await send_task_to_agent(task, agent, resumed_from_waiting_queue=True)


def default_agent_name(agent_id: str) -> str:
    names = ["Patch Goblin", "Test Mage", "Repo Scout", "Browser Sprite", "Shell Knight", "Review Owl"]
    return names[sum(ord(ch) for ch in agent_id) % len(names)]


async def snapshot() -> dict[str, Any]:
    return {
        "time": now_iso(),
        "agents": [agent.snapshot() for agent in agents.values()],
        "tasks": list(tasks.values())[-20:],
        "events": recent_events[-40:],
        "qwen": {
            "model": router.model,
            "mode": "openai-compatible" if router.base_url else "heuristic-fallback",
            "base_url": router.base_url or None,
        },
    }


async def broadcast(event_type: str, payload: dict[str, Any]) -> None:
    msg = envelope(event_type, payload)
    stale: list[WebSocket] = []
    for client in list(gui_clients):
        try:
            await client.send_json(msg)
        except Exception:
            stale.append(client)
    for client in stale:
        gui_clients.discard(client)


async def append_event(event_type: str, payload: dict[str, Any]) -> None:
    event = {"time": now_iso(), "event": event_type, "payload": payload}
    recent_events.append(event)
    if len(recent_events) > 200:
        del recent_events[:100]
    RUNTIME_DIR.mkdir(exist_ok=True)
    with EVENT_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def require_tool_token(request: Request) -> None:
    if not TOOL_TOKEN:
        return
    auth = request.headers.get("authorization", "")
    bearer = auth.removeprefix("Bearer ").strip() if auth.lower().startswith("bearer ") else ""
    token = request.headers.get("x-pocket-token", "") or bearer
    if token != TOOL_TOKEN:
        raise HTTPException(status_code=401, detail="missing or invalid pocket tool token")


def main() -> None:
    host = os.getenv("POCKET_VIBE_HOST", "0.0.0.0")
    port = int(os.getenv("POCKET_VIBE_PORT", "8787"))
    print(f"Pocket Vibe Device Hub running at http://127.0.0.1:{port}")
    print(f"Desktop agent token: {DEV_TOKEN}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
