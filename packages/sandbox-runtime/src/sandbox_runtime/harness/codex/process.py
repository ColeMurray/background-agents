"""Linux subreaper script for one native harness process domain.

Executed directly, and the containment implementation is loaded by file path,
so this process does not import the harness registry.
"""

from __future__ import annotations

import ctypes
import importlib.util
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def _load_containment() -> Any:
    """Load the sibling containment module without importing the harness package."""
    path = Path(__file__).resolve().parents[2] / "process_containment.py"
    spec = importlib.util.spec_from_file_location("openinspect_process_containment", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"process containment module is missing: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    containment = _load_containment()
    failure = int(containment.CONTAINMENT_FAILURE_EXIT_CODE)
    if sys.platform != "linux" or platform.machine() != "x86_64" or len(sys.argv) < 2:
        return failure
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return failure
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
        contained = bool(containment.contain_descendants())
    return 0 if contained else failure


if __name__ == "__main__":
    raise SystemExit(main())
