"""Single-instance guard for the sandbox supervisor process.

Providers can exec a duplicate entrypoint into a sandbox whose original
supervisor is still alive (OpenComputer wake after pause/resume re-runs the
start command, but the paused supervisor survives the suspension). Two
supervisors mean two OpenCode processes fighting over one SQLite store
("database is locked" crash loops) and two bridges claiming one sandbox
identity at the control plane.

The guard is an advisory flock held for the winning process's lifetime — see
SUPERVISOR_LOCK_FILE_PATH for why flock rather than a pidfile check. The
guard only reports outcomes; the policy for an UNAVAILABLE lock (proceed
unguarded vs refuse to boot) belongs to the entrypoint that owns the
process lifecycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import enum
import errno
import fcntl
import os
import signal
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .constants import SUPERVISOR_LOCK_FILE_PATH

if TYPE_CHECKING:
    from .log_config import StructuredLogger

ORPHAN_TERM_TIMEOUT_SECONDS = 5.0


class SupervisorLockOutcome(enum.Enum):
    """Result of the single-supervisor lock acquisition."""

    ACQUIRED = "acquired"
    ALREADY_RUNNING = "already_running"
    UNAVAILABLE = "unavailable"


def _cmdline_is_orphan_runtime(argv: list[str]) -> bool:
    """Whether ``argv`` is a runtime child a dead supervisor could have left behind.

    Matches only the two processes whose duplication breaks correctness: the
    OpenCode server (one SQLite store, one owner of its port) and the bridge
    (one WebSocket identity per sandbox at the control plane). Sidecars
    (code-server, ttyd) are deliberately not matched — a duplicate there only
    burns its own restart budget.
    """
    if not argv:
        return False
    if Path(argv[0]).name == "opencode" and argv[1:2] == ["serve"]:
        return True
    return "sandbox_runtime.bridge" in argv[1:] and Path(argv[0]).name.startswith("python")


def _parse_stat_start_time(stat: bytes) -> str | None:
    """Extract the start-time field from ``/proc/<pid>/stat`` content.

    The comm field (2) is parenthesized and may itself contain spaces or
    parentheses, so fields are counted from after its closing paren: the
    remainder starts at field 3 and start time is field 22.
    """
    fields = stat.rsplit(b")", 1)[-1].split()
    if len(fields) < 20:
        return None
    return fields[19].decode()


def _proc_start_time(pid: int) -> str | None:
    """The kernel start time of ``pid``, or None once it is gone.

    A bare PID can be recycled by an unrelated process; a (pid, start time)
    pair is a stable identity for the lifetime of the original process.
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_bytes()
    except OSError:
        return None
    return _parse_stat_start_time(stat)


class SupervisorGuard:
    """Owns the sandbox-wide single-supervisor flock and orphan cleanup.

    Constructed and released at the entrypoint boundary (``main()``), so the
    lock's lifetime is lexical rather than threaded through supervisor
    shutdown. The kernel releases the flock at process death regardless
    (SIGKILL and OOM included); explicit release just makes the handoff
    prompt for a replacement exec'd while this process is still unwinding.
    """

    def __init__(
        self,
        log: StructuredLogger,
        lock_path: str = SUPERVISOR_LOCK_FILE_PATH,
        term_timeout_seconds: float = ORPHAN_TERM_TIMEOUT_SECONDS,
    ):
        self.log = log
        self.lock_path = lock_path
        self.term_timeout_seconds = term_timeout_seconds
        self._lock_fd: int | None = None

    def acquire(self) -> SupervisorLockOutcome:
        """Take the single-supervisor lock, or report why it wasn't taken.

        ALREADY_RUNNING carries the holder's PID in the log for diagnosis.
        UNAVAILABLE means the lock file itself could not be used — the caller
        decides whether an unguarded boot is acceptable.
        """
        try:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError as e:
            self.log.warn("supervisor.lock_error", exc=e)
            return SupervisorLockOutcome.UNAVAILABLE
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            if e.errno not in (errno.EWOULDBLOCK, errno.EAGAIN):
                os.close(fd)
                self.log.warn("supervisor.lock_error", exc=e)
                return SupervisorLockOutcome.UNAVAILABLE
            holder_pid = ""
            with contextlib.suppress(OSError):
                holder_pid = os.read(fd, 64).decode(errors="replace").strip()
            os.close(fd)
            self.log.info("supervisor.already_running", holder_pid=holder_pid)
            return SupervisorLockOutcome.ALREADY_RUNNING
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self._lock_fd = fd
        return SupervisorLockOutcome.ACQUIRED

    def release(self) -> None:
        """Drop the lock (idempotent); safe to call without a held lock."""
        if self._lock_fd is None:
            return
        with contextlib.suppress(OSError):
            os.close(self._lock_fd)
        self._lock_fd = None

    def _find_orphan_runtime_processes(self) -> list[tuple[int, str]]:
        """(pid, start time) of runtime children left behind by a dead supervisor.

        Scans /proc (absent outside Linux → empty result). Any process
        matching the runtime signatures cannot belong to a live supervisor:
        a live one would hold the lock and this guard's owner would not be
        running.
        """
        processes: list[tuple[int, str]] = []
        for entry in Path("/proc").glob("[0-9]*"):
            pid = int(entry.name)
            if pid == os.getpid():
                continue
            try:
                argv = (entry / "cmdline").read_bytes().decode(errors="replace").split("\x00")
            except OSError:
                continue
            if not _cmdline_is_orphan_runtime([arg for arg in argv if arg]):
                continue
            start_time = _proc_start_time(pid)
            if start_time is not None:
                processes.append((pid, start_time))
        return processes

    async def reap_orphan_runtime_processes(self) -> None:
        """Terminate OpenCode/bridge processes orphaned by a dead supervisor.

        Without this, a supervisor that died leaving children (possible where
        the entrypoint is not PID 1, e.g. OpenComputer's nohup'd exec) forces
        the replacement's OpenCode into a port-bind crash loop against the
        orphan until MAX_RESTARTS gives up.

        Must only run while holding the lock: the sweep treats every matching
        process as ownerless, which is unsound if a live supervisor may exist.
        Each PID's start time is captured at discovery and revalidated before
        SIGKILL, so a PID recycled during the grace period is never signalled.
        """
        signalled: list[tuple[int, str]] = []
        for pid, start_time in self._find_orphan_runtime_processes():
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                continue
            self.log.info("supervisor.orphan_terminated", pid=pid)
            signalled.append((pid, start_time))
        pending = signalled
        deadline = time.monotonic() + self.term_timeout_seconds
        while pending and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
            pending = [(pid, st) for pid, st in pending if _proc_start_time(pid) == st]
        for pid, start_time in pending:
            if _proc_start_time(pid) != start_time:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
                self.log.warn("supervisor.orphan_killed", pid=pid)
            except OSError:
                pass
