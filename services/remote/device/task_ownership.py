"""Task-local Linux descendant ownership. No daemon, root privileges or SID inference."""
from __future__ import annotations

import ctypes
import os
import signal
import sys
import time
from pathlib import Path


def linux_boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def linux_process(pid: int) -> tuple[dict | None, int | None]:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None, None
    fields = stat[stat.rfind(")") + 2:].split()
    return {"pid": pid, "start_ticks": int(fields[19]), "boot_id": linux_boot_id()}, int(fields[1])


def linux_identity(pid: int) -> dict | None:
    return linux_process(pid)[0]


def children(pid: int) -> list[int]:
    """Read all threads: a CLI can fork from a worker thread, not just its leader."""
    result = set()
    try:
        threads = list(Path(f"/proc/{pid}/task").iterdir())
    except FileNotFoundError:
        return []
    for thread in threads:
        try:
            result.update(map(int, (thread / "children").read_text().split()))
        except FileNotFoundError:
            pass
    return sorted(result)


def descendants(owner: dict) -> list[dict]:
    if linux_identity(owner["pid"]) != owner:
        return []
    pending, found = [owner], {}
    while pending:
        parent = pending.pop()
        if linux_identity(parent["pid"]) != parent:
            continue
        for pid in children(parent["pid"]):
            identity, ppid = linux_process(pid)
            # A child-list PID can disappear/recycle before stat is read. Check
            # both sides of its live parent relationship before claiming it.
            if identity and ppid == parent["pid"] and linux_identity(parent["pid"]) == parent and pid not in found:
                found[pid] = identity
                pending.append(identity)
    return list(found.values())


def kill_identity(identity: dict) -> None:
    """A pidfd pins the actual process; never signal a recycled numeric PID."""
    if identity.get("boot_id") != linux_boot_id():
        return
    try:
        handle = os.pidfd_open(identity["pid"], 0)
    except ProcessLookupError:
        return
    try:
        if linux_identity(identity["pid"]) == identity:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
    finally:
        os.close(handle)


class LinuxTaskTree:
    def __init__(self):
        if not sys.platform.startswith("linux") or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise RuntimeError("Reliable task descendant cleanup requires Linux subreaper and pidfd support; task was not started")
        handle = os.pidfd_open(os.getpid(), 0)
        try:
            signal.pidfd_send_signal(handle, 0)
        finally:
            os.close(handle)
        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_CHILD_SUBREAPER. Orphaned descendants, including setsid/double
        # forks, are adopted by this task's guardian rather than disappearing
        # into init. Only this guardian's descendants are enumerated.
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Could not enable task subreaper")
        enabled = ctypes.c_int()
        if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
            raise RuntimeError("Task subreaper could not be verified")
        self.owner = linux_identity(os.getpid())
        if not self.owner:
            raise RuntimeError("Task guardian identity unavailable")

    def snapshot(self) -> list[dict]:
        return descendants(self.owner)

    def cleanup(self, proc, persist) -> None:
        deadline = time.monotonic() + 10
        while True:
            if proc is not None:
                proc.poll()  # Reap through Popen, preserving its exit code.
            direct = children(os.getpid())
            if not direct:
                return  # Kernel descendant chain empty, not just the original SID.
            owned = self.snapshot()
            persist(owned)
            for identity in owned:
                kill_identity(identity)
            for pid in direct:
                if proc is None or pid != proc.pid:
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            if time.monotonic() >= deadline:
                raise RuntimeError("Task descendant chain has not exited")
            time.sleep(.02)


def recover_linux(state: dict) -> None:
    owner = state.get("owner", {})
    if owner.get("boot_id") and owner["boot_id"] != linux_boot_id():
        return  # A different kernel boot proves the entire previous chain ended.
    tracked = {item["pid"]: item for item in state.get("tracked", [])}
    # Recover descendants of recorded, still-identical processes too. This is
    # best-effort cleanup, never a whole-chain proof after the subreaper died.
    for identity in list(tracked.values()):
        for child in descendants(identity):
            tracked[child["pid"]] = child
    state["tracked"] = list(tracked.values())
    for identity in tracked.values():
        kill_identity(identity)
    raise RuntimeError("Previous subreaper died without a whole-chain exit proof; recovery remains unconfirmed (unrecorded forks may exist)")
