"""Subreaper that owns one agent-bridge process and its vendor descendants.

The supervisor launches the bridge through this owner. Native exec tools can
call ``setsid()``, so a process group is not an ownership domain: this parent
adopts orphaned descendants, and when the bridge exits for any reason
(including ``SIGKILL``) it freezes and reaps that tree before it exits.

Its exit status is the bridge's when containment succeeded, or
``CONTAINMENT_FAILURE_EXIT_CODE`` when it did not. Killing this owner is not
containment, and the supervisor must not start another bridge until this
process has exited successfully.
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

from .harness.codex.process import (
    CONTAINMENT_FAILURE_EXIT_CODE as CONTAINMENT_FAILURE_EXIT_CODE,
)
from .harness.codex.process import contain_descendants

# Shorter than ``AgentBridgeProcess``'s stop wait, so a graceful bridge exit
# and the reap that follows both finish before the supervisor SIGKILLs us.
GRACEFUL_STOP_SECONDS = 4.0
_PR_SET_PDEATHSIG = 1
_PR_SET_CHILD_SUBREAPER = 36


def _child_exit_code(process: subprocess.Popen[bytes]) -> int:
    """The bridge's status, once its descendants are gone.

    ``CONTAINMENT_FAILURE_EXIT_CODE`` is reserved for this owner. A bridge that
    happens to exit with it is reported as a generic crash so the supervisor
    still restarts; an unconfirmed reap must not look like an ordinary exit.
    """
    code = process.returncode
    if code is None:
        return CONTAINMENT_FAILURE_EXIT_CODE
    if code < 0:
        return 128 + min(-code, 127)
    if code == CONTAINMENT_FAILURE_EXIT_CODE:
        return 1
    return min(code, 255)


def main() -> int:
    if sys.platform != "linux" or platform.machine() != "x86_64" or len(sys.argv) < 2:
        return CONTAINMENT_FAILURE_EXIT_CODE
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        return CONTAINMENT_FAILURE_EXIT_CODE
    # If the supervisor dies, the kernel signals us so the tree is still reaped.
    # Compare parent identity after the call: the entrypoint is pid 1, so
    # "parent is 1" is not proof that it died.
    parent = os.getppid()
    if libc.prctl(_PR_SET_PDEATHSIG, int(signal.SIGTERM), 0, 0, 0) != 0:
        return CONTAINMENT_FAILURE_EXIT_CODE
    if os.getppid() != parent:
        return CONTAINMENT_FAILURE_EXIT_CODE

    stopping = False
    process = subprocess.Popen(sys.argv[1:])

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                process.send_signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    graceful_deadline: float | None = None
    while process.poll() is None:
        if stopping:
            if graceful_deadline is None:
                graceful_deadline = time.monotonic() + GRACEFUL_STOP_SECONDS
            if time.monotonic() >= graceful_deadline:
                break
        time.sleep(0.02)
    # Reap the bridge through Popen before the descendant walk. ``waitpid``
    # inside containment would otherwise consume the exit status.
    if process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=1)
    # Record this before the descendant walk. If the bridge is still alive,
    # containment reaps it with waitpid and a later Popen.poll() reports
    # status 0, which the supervisor would treat as a graceful exit.
    bridge_reaped = process.poll() is not None
    contained = contain_descendants()
    if not contained or not bridge_reaped:
        return CONTAINMENT_FAILURE_EXIT_CODE
    return _child_exit_code(process)


if __name__ == "__main__":
    raise SystemExit(main())
