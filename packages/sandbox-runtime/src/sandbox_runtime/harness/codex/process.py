"""Linux subreaper for one native harness process domain.

Native exec tools can call setsid(), so a process group is not an ownership
domain. This small parent adopts orphaned descendants, freezes the whole
remaining tree and reaps it before exiting successfully. It owns no unrelated
sandbox process. Killing this owner itself is NOT proof of containment.
"""

from __future__ import annotations

import contextlib
import ctypes
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path

CONTAINMENT_FAILURE_EXIT_CODE = 88
CONTAINMENT_TIMEOUT_SECONDS = 3.0
_LIBC = ctypes.CDLL(None, use_errno=True)


def _syscall(number: int, *arguments: int) -> int:
    # The packaged python-build-standalone omits os.pidfd_open and
    # signal.pidfd_send_signal. Use the same kernel ownership handles via libc.
    # Linux x86-64 ABI: arch/x86/entry/syscalls/syscall_64.tbl, 424 and 434.
    _LIBC.syscall.restype = ctypes.c_long
    result = int(_LIBC.syscall(*(ctypes.c_long(value) for value in (number, *arguments))))
    if result == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def _children(pid: int) -> set[int]:
    children: set[int] = set()
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except (FileNotFoundError, ProcessLookupError):
        return children
    for task in tasks:
        with contextlib.suppress(FileNotFoundError, ProcessLookupError):
            children.update(int(value) for value in (task / "children").read_text().split())
    return children


def _signal(fd: int, sig: signal.Signals) -> None:
    with contextlib.suppress(ProcessLookupError):
        _syscall(424, fd, sig, 0, 0)  # pidfd_send_signal(fd, sig, NULL, flags=0)


def _freeze_tree(parent: int, owned: dict[int, int]) -> None:
    pending = [(parent, pid) for pid in _children(parent)]
    while pending:
        parent, pid = pending.pop()
        if pid in owned:
            pending.extend((pid, child) for child in _children(pid))
            continue
        try:
            fd = _syscall(434, pid, 0)  # pidfd_open(pid, flags=0)
        except (FileNotFoundError, ProcessLookupError):
            # Modal's gVisor can report ENOENT instead of ESRCH when the
            # enumerated process exits before pidfd_open reaches the kernel.
            continue
        try:
            # Validate ancestry after acquiring the stable identity. A recycled
            # PID must never let shutdown signal an unrelated sandbox process.
            status = Path(f"/proc/{pid}/status").read_text().splitlines()
            if f"PPid:\t{parent}" not in status:
                os.close(fd)
                continue
        except (FileNotFoundError, ProcessLookupError):
            os.close(fd)
            continue
        owned[pid] = fd
        _signal(fd, signal.SIGSTOP)
        pending.extend((pid, child) for child in _children(pid))


def _contain() -> bool:
    deadline = time.monotonic() + CONTAINMENT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        owned: dict[int, int] = {}
        try:
            _freeze_tree(os.getpid(), owned)
            # Rewalk after SIGSTOP delivery to catch concurrent forks/adoption.
            time.sleep(0.01)
            _freeze_tree(os.getpid(), owned)
            for fd in owned.values():
                _signal(fd, signal.SIGKILL)
        finally:
            for fd in owned.values():
                os.close(fd)
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return not _children(os.getpid())
            if pid == 0:
                break
        time.sleep(0.01)
    return False


def main() -> int:
    if sys.platform != "linux" or platform.machine() != "x86_64" or len(sys.argv) < 2:
        return CONTAINMENT_FAILURE_EXIT_CODE
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return CONTAINMENT_FAILURE_EXIT_CODE
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        process = subprocess.Popen(sys.argv[1:])
        while not stopping and process.poll() is None:
            time.sleep(0.02)
    finally:
        contained = _contain()
    return 0 if contained else CONTAINMENT_FAILURE_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())
