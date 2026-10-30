"""The bridge domain owner reaps setsid descendants before it exits."""

import asyncio
import os
import platform
import signal
import sys
from pathlib import Path

import pytest

import sandbox_runtime

pytestmark = pytest.mark.skipif(
    sys.platform != "linux" or platform.machine() != "x86_64",
    reason="Linux x86_64 subreaper contract",
)

_SRC = str(Path(sandbox_runtime.__file__).resolve().parent.parent)


def _env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((_SRC, env.get("PYTHONPATH", "")))
    return env


def _script(pidfile: Path, bridge_pid: Path, ready: Path) -> str:
    grandchild = (
        "import os, time\n"
        "from pathlib import Path\n"
        f"Path({str(pidfile)!r}).write_text(str(os.getpid()))\n"
        "while True:\n"
        "    time.sleep(0.05)\n"
    )
    return (
        "import os, subprocess, sys, time\n"
        "from pathlib import Path\n"
        f"Path({str(bridge_pid)!r}).write_text(str(os.getpid()))\n"
        f"subprocess.Popen([sys.executable, '-c', {grandchild!r}], start_new_session=True)\n"
        f"deadline = time.monotonic() + 5\n"
        f"while not Path({str(pidfile)!r}).exists():\n"
        "    if time.monotonic() > deadline:\n"
        "        raise SystemExit('grandchild did not start')\n"
        "    time.sleep(0.02)\n"
        f"Path({str(ready)!r}).write_text('ready')\n"
        "time.sleep(60)\n"
    )


async def _wait_for(path: Path) -> None:
    async with asyncio.timeout(5):
        while not path.exists():
            await asyncio.sleep(0.02)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_setsid_descendant_is_dead_before_the_domain_owner_exits(tmp_path: Path):
    pidfile = tmp_path / "grandchild.pid"
    bridge_pid = tmp_path / "bridge.pid"
    ready = tmp_path / "ready"
    script = tmp_path / "bridge.py"
    script.write_text(_script(pidfile, bridge_pid, ready))
    unrelated = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time; time.sleep(60)"
    )
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "sandbox_runtime.bridge_domain",
        sys.executable,
        str(script),
        env=_env(),
    )
    grandchild = 0
    try:
        await _wait_for(ready)
        grandchild = int(pidfile.read_text())
        assert _alive(grandchild)
        os.kill(int(bridge_pid.read_text()), signal.SIGKILL)
        # The successor may start only after this wait: the owner exits once
        # the descendant tree is gone.
        code = await asyncio.wait_for(owner.wait(), timeout=5)
        assert code == 128 + signal.SIGKILL
        assert not _alive(grandchild)
        assert unrelated.returncode is None
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if grandchild and _alive(grandchild):
            os.kill(grandchild, signal.SIGKILL)
        unrelated.kill()
        await unrelated.wait()


async def test_killing_the_domain_owner_is_not_containment(tmp_path: Path):
    pidfile = tmp_path / "grandchild.pid"
    bridge_pid = tmp_path / "bridge.pid"
    ready = tmp_path / "ready"
    script = tmp_path / "bridge.py"
    script.write_text(_script(pidfile, bridge_pid, ready))
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "sandbox_runtime.bridge_domain",
        sys.executable,
        str(script),
        env=_env(),
    )
    grandchild = 0
    try:
        await _wait_for(ready)
        grandchild = int(pidfile.read_text())
        assert owner.pid is not None
        os.kill(owner.pid, signal.SIGKILL)
        code = await asyncio.wait_for(owner.wait(), timeout=5)
        assert code < 0
        assert _alive(grandchild)
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if grandchild and _alive(grandchild):
            os.kill(grandchild, signal.SIGKILL)
        bridge = int(bridge_pid.read_text()) if bridge_pid.exists() else 0
        if bridge and _alive(bridge):
            os.kill(bridge, signal.SIGKILL)
