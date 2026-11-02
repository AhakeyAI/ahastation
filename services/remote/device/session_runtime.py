"""Per-user device identity and OS-backed native-session locks (shared by Bridges)."""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from pathlib import Path


def state_dir() -> Path:
    path = Path(os.environ.get("POCKET_VIBE_STATE_DIR", str(Path.home() / ".pocket-vibe")))
    path.mkdir(parents=True, exist_ok=True)
    return path


def device_id() -> str:
    path = state_dir() / "device-id"
    # Atomic creation, with readers waiting for the very short initial write.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        for _ in range(100):
            value = path.read_text(encoding="utf-8").strip()
            if value:
                return str(uuid.UUID(value))
            time.sleep(0.01)
        raise RuntimeError("Device identity file is empty; repair .pocket-vibe/device-id before starting Bridge")
    value = str(uuid.uuid4())
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    return value


def session_key(provider: str, session_id: str) -> str:
    return hashlib.sha256(json.dumps([device_id(), provider, session_id]).encode()).hexdigest()


class SessionLock:
    """Kernel releases the lock after a crash; recovery metadata survives it."""
    def __init__(self, provider: str, native_id: str):
        root = state_dir() / "sessions"
        root.mkdir(exist_ok=True)
        key = session_key(provider, native_id)
        self.path = root / f"{key}.json"
        self.stream = (root / f"{key}.lock").open("a+b")
        if self.stream.tell() == 0:
            self.stream.write(b"0")
            self.stream.flush()

    def try_acquire(self) -> bool:
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (BlockingIOError, OSError):
            return False

    def read(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def write(self, value: dict) -> None:
        temp = self.path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temp, self.path)

    def close(self) -> None:
        self.stream.close()


def execution_status(provider: str, native_id: str) -> str:
    lock = SessionLock(provider, native_id)
    try:
        acquired = lock.try_acquire()
        state = lock.read()
        if not acquired:
            return "cleanup-unconfirmed" if state.get("status") == "cleanup-unconfirmed" else "running"
        if state.get("containment") == "macos-launch-pending" and state.get("status") == "waiting":
            from macos_task import pending_alive
            if pending_alive(state): return "waiting"
        # Kernel lock release after a crash is not a descendant exit proof.
        return "idle" if state.get("status") == "idle" else (
            "cleanup-unconfirmed" if state else "unknown")
    finally:
        lock.close()
