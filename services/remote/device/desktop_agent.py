from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import socket
import sys
from pathlib import Path
from typing import Any

import websockets

from protocol import ack, envelope, now_iso
from session_runtime import device_id, execution_status


def execution_support_error() -> str:
    if sys.platform == "darwin":
        from macos_task import macos_support_error
        return macos_support_error()
    return ""


ROOT = Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parents[1]))
RUNTIME_DIR = ROOT / "runtime"
OUTBOX = RUNTIME_DIR / "desktop_outbox.jsonl"


BASE_CAPABILITIES = ["system.info", "agent.echo", "browser.open"]


class LocalAgentRunner:
    """
    Safe adapter from the desktop bridge to a local agent process.

    The hub never sends shell commands. The local operator pre-configures one
    command locally; tasks are passed to that command as JSON over stdin.
    """

    def __init__(self, config_path: str = "", timeout_seconds: float = 120.0) -> None:
        self.config_path = Path(config_path).resolve() if config_path else None
        self.config: dict[str, Any] = {}
        if self.config_path:
            self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.timeout_seconds = float(self.config.get("timeout_seconds", timeout_seconds))
        self.command = self._load_command()
        self.working_dir = self._load_working_dir()
        self.display_name = str(self.config.get("display_name", "")).strip()
        self.route_by_default = bool(self.config.get("route_by_default", True))

    @property
    def enabled(self) -> bool:
        return bool(self.command)

    @property
    def capabilities(self) -> list[str]:
        configured = self.config.get("capabilities", [])
        caps = ["local.agent", "agent.execute"]
        if isinstance(configured, list):
            caps.extend(str(item) for item in configured)
        return unique(caps)

    async def run(self, msg: dict[str, Any], on_state: Any = None) -> dict[str, Any]:
        if not self.enabled:
            return {
                "ok": False,
                "capability": "local.agent",
                "error": "Local agent command is not configured.",
                "hint": "Start desktop_agent.py with --local-agent-config configs/local_agent.example.json",
            }

        payload = msg.get("payload", {})
        if self.config.get('codex_access') == 'desktop':
            from codex_shared import run_task
            return await run_task(self.config, msg, on_state)
        if error := execution_support_error():
            return {"ok": False, "capability": "local.agent", "cleanup_confirmed": True, "error": error}
        task_input = {
            "task_id": msg.get("task_id"),
            "msg_id": msg.get("msg_id"),
            "received_at": now_iso(),
            "objective": payload.get("objective", ""),
            "decision": payload.get("decision", {}),
            "safe_mode": payload.get("safe_mode", True),
            "provider": payload.get("provider", ""),
            "session_id": payload.get("session_id", ""),
            "cwd": payload.get("cwd", ""),
            "turn_options": payload.get("turn_options", {}),
            "metadata": payload.get("metadata", {}),
            "bridge": {
                "platform": platform.platform(),
                "hostname": socket.gethostname(),
                "working_dir": str(self.working_dir) if self.working_dir else None,
            },
        }
        options = task_input["turn_options"] if isinstance(task_input["turn_options"], dict) else {}
        provider = next((p for p in ("codex", "claude")
                    if any(cap.startswith(p + ".") for cap in self.capabilities)), "") or task_input["provider"]
        native_id = options.get("session_id") or task_input["session_id"]
        # Legacy pinned adapters also share the native-session lock.
        if not native_id and "--session-id" in self.command:
            native_id = self.command[self.command.index("--session-id") + 1]
        if not native_id:
            native_id = next((arg.split("=", 1)[1] for arg in self.command if arg.startswith("--session-id=")), "")
        if not native_id and provider in {"codex", "claude"}:
            native_id = os.getenv(f"POCKET_VIBE_{provider.upper()}_SESSION_ID", "")
        spec = {"task": task_input, "command": self.command,
                "working_dir": str(self.working_dir) if self.working_dir else None,
                "timeout": self.timeout_seconds, "provider": provider, "session_id": native_id,
                "remote_target": payload.get("remote_target")}
        if self.config.get('project_policy') is not None:
            spec['project_policy']=self.config['project_policy']
        if msg.get('_journal_dir'):
            spec['_journal_dir']=msg['_journal_dir']
        stdin_data = json.dumps(spec, ensure_ascii=False).encode("utf-8")

        try:
            from runtime_entry import python_command
            proc = await asyncio.create_subprocess_exec(
                *python_command(Path(__file__).with_name("task_process.py")),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=16 * 1024 * 1024,
            )
        except FileNotFoundError as exc:
            return {
                "ok": False,
                "capability": "local.agent",
                "error": f"Configured local agent command was not found: {exc.filename}",
                "command": self.command,
            }

        assert proc.stdin and proc.stdout and proc.stderr
        proc.stdin.write(stdin_data)
        await proc.stdin.drain()
        proc.stdin.close()
        errors = asyncio.create_task(proc.stderr.read())
        result: dict[str, Any] = {"ok": False, "error": "Task guardian exited without a result", "cleanup_confirmed": False}
        protocol_error = ""
        try:
            while raw := await proc.stdout.readline():
                try:
                    frame = json.loads(raw)
                except (ValueError, UnicodeError) as exc:
                    protocol_error = f"Task guardian protocol failed: {exc}"
                    continue  # Drain/wait for owned tree cleanup before returning failure.
                if frame.get("type") == "state" and on_state:
                    try:
                        await on_state(frame["status"])
                    except Exception:
                        pass  # A status delivery failure must not abandon cleanup.
                if frame.get("type") == "result":
                    result = frame["result"]
            await proc.wait()  # Never release a turn on the first result frame alone.
            stderr = await errors
            if proc.returncode:
                result.update(ok=False, error=f"Task guardian failed: {stderr.decode(errors='replace')[:8000]}")
            if protocol_error:
                result.update(ok=False, error=protocol_error)
            return {**result, "command": self.command, "working_dir": spec["working_dir"]}
        finally:
            # If the Bridge is cancelled/crashes, the guardian retains the OS
            # lock, owns its timeout, and cleans the tree before unlocking.
            if not errors.done():
                errors.cancel()

    def _load_command(self) -> list[str]:
        command = self.config.get("command", [])
        if isinstance(command, str):
            raise ValueError("local agent config field 'command' must be a list, not a string")
        if not isinstance(command, list):
            return []
        return [str(item) for item in command if str(item).strip()]

    def _load_working_dir(self) -> Path | None:
        raw = str(self.config.get("working_dir", "")).strip()
        if not raw:
            return None
        path = Path(raw)
        if not path.is_absolute() and self.config_path:
            path = self.config_path.parent.parent / path
        return path.resolve()


class DesktopBridge:
    def __init__(
        self,
        hub: str,
        token: str,
        agent_id: str | None = None,
        display_name: str | None = None,
        local_agent_config: str = "",
        local_agent_timeout: float = 120.0,
    ) -> None:
        self.hub = hub
        self.token = token
        self.agent_id = agent_id or f"{platform.system().lower()}-{socket.gethostname()}"
        self.local_agent = LocalAgentRunner(local_agent_config, local_agent_timeout)
        self.display_name = (
            display_name
            or os.getenv("POCKET_VIBE_DISPLAY_NAME")
            or self.local_agent.display_name
            or ""
        )
        self.stop_event = asyncio.Event()
        self.task_lock = asyncio.Lock()
        self.pending_tasks: set[asyncio.Task[None]] = set()
        self.scan_lock = asyncio.Lock()
        self.device_id = device_id()

    async def run_forever(self) -> None:
        delay = 1.0
        while not self.stop_event.is_set():
            try:
                await self._connect_once()
                delay = 1.0
            except Exception as exc:
                print(f"[{now_iso()}] disconnected: {exc.__class__.__name__}: {exc}")
            print(f"[{now_iso()}] reconnecting in {delay:.1f}s")
            await asyncio.sleep(delay)
            delay = min(delay * 1.8, 30.0)

    async def _connect_once(self) -> None:
        uri = f"{self.hub}?token={self.token}&agent_id={self.agent_id}"
        print(f"[{now_iso()}] connecting {self.hub}?token=<redacted>&agent_id={self.agent_id}")
        async with websockets.connect(uri, ping_interval=10, ping_timeout=10, close_timeout=3) as ws:
            await ws.send(json.dumps(envelope("hello", self._hello_payload()), ensure_ascii=False))
            await self._flush_outbox(ws)
            await self._publish_sessions(ws)
            async for raw in ws:
                msg = json.loads(raw)
                await self._handle_message(ws, msg)

    async def _handle_message(self, ws: Any, msg: dict[str, Any]) -> None:
        msg_type = msg.get("type")
        if msg_type == "heartbeat":
            await ws.send(json.dumps(envelope("pong", {"agent_time": now_iso()}, ack_of=msg.get("msg_id")), ensure_ascii=False))
            return
        if msg_type == "task":
            await ws.send(json.dumps(ack(msg, {"agent_id": self.agent_id}), ensure_ascii=False))
            task = asyncio.create_task(self._execute_and_report(ws, msg))
            self.pending_tasks.add(task)
            task.add_done_callback(self.pending_tasks.discard)
            return
        if msg_type == "ack":
            return
        if msg_type == "refresh_sessions":
            task = asyncio.create_task(self._publish_sessions(ws, msg.get("msg_id", "")))
            self.pending_tasks.add(task)
            task.add_done_callback(self.pending_tasks.discard)
            return
        print(f"[{now_iso()}] hub message: {msg_type} {msg.get('payload')}")

    async def _execute_and_report(self, ws: Any, msg: dict[str, Any]) -> None:
        async def state(status: str) -> None:
            try:
                await ws.send(json.dumps(envelope("task_state", {"status": status}, task_id=msg.get("task_id"))))
            except Exception:
                pass  # Disconnection does not interrupt execution/cleanup.
        await state("waiting")
        from contextlib import nullcontext
        # Shared Desktop tasks have native per-thread admission. A busy thread
        # must not block other threads behind the legacy single-runner queue.
        async with (nullcontext() if self.local_agent.config.get('codex_access') == 'desktop' else self.task_lock):
            try:
                target = msg.get("payload", {}).get("remote_target")
                if target:
                    catalog = await asyncio.to_thread(self._scan_sessions)
                    payload = msg.get("payload", {})
                    options = payload.get("turn_options", {})
                    if (not isinstance(options, dict) or target.get("agent_id") != self.agent_id
                        or payload.get("provider") != target.get("provider")
                        or payload.get("session_id") != target.get("session_id")
                        or payload.get("cwd") != target.get("cwd")
                        or options.get("session_id", payload.get("session_id")) != target.get("session_id")
                        or options.get("cwd", payload.get("cwd")) != target.get("cwd")
                        or options.get("mode", "resume") != "resume"):
                        raise ValueError("Remote reference does not match task execution parameters")
                    if target.get("device_id") != self.device_id or target.get("provider") != self._session_provider() or not any(
                        row["session_id"] == target.get("session_id") and row["cwd"] == target.get("cwd") and row.get("available") is not False
                        for row in catalog["sessions"]
                    ):
                        raise ValueError(catalog.get("error") or "Selected remote session is unavailable or mismatched")
                result = await self._execute_task(msg, state)
            except Exception as exc:
                result = {"ok": False, "error": f"Agent 执行失败：{type(exc).__name__}: {exc}"}
            result_msg = envelope("result", result, task_id=msg.get("task_id"))
            await self._send_or_spool(ws, result_msg)

    async def _execute_task(self, msg: dict[str, Any], on_state: Any = None) -> dict[str, Any]:
        payload = msg.get("payload", {})
        decision = payload.get("decision", {})
        capability = decision.get("target_capability", "agent.echo")
        objective = payload.get("objective", "")

        if payload.get("remote_target") and self.local_agent.enabled:
            return await self.local_agent.run(msg, on_state)

        if capability == "system.info":
            return {
                "ok": True,
                "capability": capability,
                "hostname": socket.gethostname(),
                "platform": platform.platform(),
                "python": sys.version.split()[0],
                "local_agent_enabled": self.local_agent.enabled,
                "safe_mode": True,
            }

        if capability == "browser.open":
            return {
                "ok": True,
                "capability": capability,
                "note": "Demo safe-mode: browser launch is simulated. Wire this to a signed local action API later.",
                "objective": objective,
            }

        if self.local_agent.enabled and (
            capability in {"local.agent", "agent.execute"}
            or capability not in BASE_CAPABILITIES
            or self.local_agent.route_by_default
        ):
            return await self.local_agent.run(msg, on_state)

        await asyncio.sleep(0.35)
        return {
            "ok": True,
            "capability": "agent.echo",
            "note": "Demo safe-mode execution complete. Configure --local-agent-config to forward tasks to your real local agent.",
            "objective": objective,
            "decision": decision,
        }

    def _hello_payload(self) -> dict[str, Any]:
        error = self._execution_error() if self.local_agent.enabled else ""
        return {
            "agent_id": self.agent_id,
            "display_name": self.display_name,
            "platform": platform.platform(),
            "hostname": socket.gethostname(),
            "device_id": self.device_id,
            "capabilities": self._capabilities(),
            "safe_mode": True,
            "local_agent_enabled": self.local_agent.enabled,
            "execution_available": self.local_agent.enabled and not error,
            "execution_error": error,
            "started_at": now_iso(),
        }

    def _capabilities(self) -> list[str]:
        caps = list(BASE_CAPABILITIES)
        if self.local_agent.enabled:
            error = self._execution_error()
            if not error:
                caps.extend(self.local_agent.capabilities)
            else:
                # A configured runner handles echo through route_by_default;
                # do not advertise that route when it cannot execute.
                if self.local_agent.route_by_default: caps.remove("agent.echo")
                if self._session_provider(): caps.append(f"{self._session_provider()}.sessions")
            if self._session_provider():
                caps.append("remote.sessions")
        return unique(caps)

    def _execution_error(self):
        if self.local_agent.config.get('codex_access') == 'desktop':
            from codex_shared import support_error
            return support_error()
        return execution_support_error()

    def _session_provider(self) -> str:
        if not self.local_agent.enabled:
            return ""
        for provider in ("codex", "claude"):
            if any(cap.startswith(f"{provider}.") for cap in self.local_agent.capabilities):
                return provider
        return ""

    def _scan_sessions(self) -> dict[str, Any]:
        provider = self._session_provider()
        if not provider:
            return {"status": "unsupported", "sessions": [], "error": "Bridge 未配置 Codex/Claude 执行器"}
        try:
            from desktop_control_panel import discover_sessions
            support_error = execution_support_error()
            if provider == 'codex' and self.local_agent.config.get('codex_access') == 'desktop':
                from codex_shared import scan_async
                references = asyncio.run(scan_async(self.local_agent.config))
                sessions = [{key: value for key, value in item.items() if key != 'source'} for item in references]
                return {'status': 'ready' if sessions else 'empty', 'sessions': sessions}
            # Reuse the console scanner, but transmit references only, never
            # its preview, prompts, history files, or local credentials.
            sessions = [{
                "provider": provider,
                "session_id": item["session_id"],
                "title": item.get("title") or item["session_id"],
                "cwd": item.get("cwd", ""),
                "available": not support_error and bool(item.get("cwd")) and Path(item["cwd"]).is_dir() and os.access(item["cwd"], os.R_OK),
                "error": support_error or ("" if item.get("cwd") and Path(item["cwd"]).is_dir() and os.access(item["cwd"], os.R_OK)
                    else "远端项目目录不存在或无法访问"),
                "execution_status": execution_status(provider, item["session_id"]),
                "native_client_status": "unknown",
            } for item in discover_sessions(provider, strict=True)]
            return {"status": "ready" if sessions else "empty", "sessions": sessions}
        except Exception as exc:
            return {"status": "failed", "sessions": [], "error": f"会话扫描失败：{exc}"}

    async def _publish_sessions(self, ws: Any, request_id: str = "") -> None:
        async with self.scan_lock:
            catalog = await asyncio.to_thread(self._scan_sessions)
            catalog.update({"request_id": request_id, "scanned_at": now_iso()})
            await ws.send(json.dumps(envelope("session_catalog", catalog), ensure_ascii=False))

    async def _send_or_spool(self, ws: Any, msg: dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(msg, ensure_ascii=False))
        except Exception:
            self._spool(msg)
            raise

    async def _flush_outbox(self, ws: Any) -> None:
        if not OUTBOX.exists():
            return
        lines = OUTBOX.read_text(encoding="utf-8").splitlines()
        if not lines:
            return
        OUTBOX.unlink(missing_ok=True)
        for line in lines:
            try:
                await ws.send(line)
            except Exception:
                self._spool(json.loads(line))
                raise

    def _spool(self, msg: dict[str, Any]) -> None:
        RUNTIME_DIR.mkdir(exist_ok=True)
        with OUTBOX.open("a", encoding="utf-8") as f:
            f.write(json.dumps(msg, ensure_ascii=False) + "\n")


def unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def trim(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n... trimmed {len(value) - limit} chars ..."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pocket Vibe Desktop Agent Bridge")
    parser.add_argument("--hub", default=os.getenv("POCKET_VIBE_HUB", "ws://127.0.0.1:8787/ws/desktop"))
    parser.add_argument("--token", default=os.getenv("POCKET_VIBE_TOKEN", "dev-token"))
    parser.add_argument("--agent-id", default=os.getenv("POCKET_VIBE_AGENT_ID", ""))
    parser.add_argument("--display-name", default=os.getenv("POCKET_VIBE_DISPLAY_NAME", ""))
    parser.add_argument("--local-agent-config", default=os.getenv("POCKET_VIBE_LOCAL_AGENT_CONFIG", ""))
    parser.add_argument("--local-agent-timeout", type=float, default=float(os.getenv("POCKET_VIBE_LOCAL_AGENT_TIMEOUT", "120")))
    return parser.parse_args()


async def amain() -> None:
    args = parse_args()
    bridge = DesktopBridge(
        args.hub,
        args.token,
        args.agent_id or None,
        args.display_name or None,
        args.local_agent_config,
        args.local_agent_timeout,
    )
    await bridge.run_forever()


if __name__ == "__main__":
    asyncio.run(amain())
