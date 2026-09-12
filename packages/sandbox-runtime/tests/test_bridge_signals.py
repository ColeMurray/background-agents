"""Real supervisor-to-bridge signals must execute async resource cleanup."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from unittest.mock import Mock

import pytest
from websockets.asyncio.server import serve

from sandbox_runtime.agent_bridge_process import AgentBridgeProcess

BRIDGE_FIXTURE = r"""
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.bridge_signals import run_bridge_with_signals
from sandbox_runtime.harness import HarnessId, TurnOutcome

directory = Path(sys.argv[1])

class Harness:
    id = HarnessId.OPENCODE
    session_id = "signal-fixture"
    child = None

    async def open(self):
        pass

    async def run_prompt(self, prompt, emit):
        self.child = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(60)",
            start_new_session=True,
        )
        (directory / "started.json").write_text(json.dumps({"pid": self.child.pid}))
        await emit({"type": "token", "messageId": prompt.message_id, "content": "started"})
        await self.child.wait()
        return TurnOutcome.ok()

    async def abort(self):
        if self.child.returncode is None:
            self.child.terminate()
        return True

    async def stop(self, deadline_monotonic):
        if self.child.returncode is None:
            self.child.kill()
        async with asyncio.timeout_at(deadline_monotonic):
            await self.child.wait()
        return True

    async def close(self):
        (directory / "closed.json").write_text(json.dumps({
            "child_reaped": self.child is None or self.child.returncode is not None,
        }))

async def main():
    bridge = AgentBridge(
        sandbox_id="signal-sandbox", session_id="signal-session",
        control_plane_url=sys.argv[2], auth_token="test", harness=Harness(),
    )
    bridge.git_signing.initialize = AsyncMock()
    bridge._configure_git_identity = AsyncMock()
    bridge._load_session_id = AsyncMock()
    bridge.repo_manifest_path = directory / "manifest.json"
    bridge._drain_boot_warnings = AsyncMock()
    bridge.diff_refresh = Mock()
    bridge.diff_refresh.close = AsyncMock()
    await run_bridge_with_signals(bridge)
    (directory / "exited").write_text("clean")

asyncio.run(main())
"""


@pytest.fixture
async def signal_control_plane():
    async def connected(ws):
        await ws.send(
            json.dumps(
                {
                    "type": "prompt",
                    "messageId": "active",
                    "content": "run",
                    "author": {"gitIdentity": {"mode": "agent-only"}},
                }
            )
        )
        await ws.wait_closed()

    async with serve(connected, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}"


@pytest.mark.asyncio
@pytest.mark.parametrize("shutdown_signal", [signal.SIGTERM, signal.SIGINT])
async def test_bridge_signal_reaps_active_detached_tool_before_clean_exit(
    tmp_path, shutdown_signal, signal_control_plane
):
    """Exercise the actual supervisor stop implementation, not task.cancel alone."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        BRIDGE_FIXTURE,
        str(tmp_path),
        signal_control_plane,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    child_pid = None
    try:
        async with asyncio.timeout(10):
            while not (tmp_path / "started.json").exists():
                if process.returncode is not None:
                    stdout, stderr = await process.communicate()
                    pytest.fail(f"Bridge fixture exited before startup: {stdout!r} {stderr!r}")
                await asyncio.sleep(0.01)
        child_pid = json.loads((tmp_path / "started.json").read_text())["pid"]
        os.kill(child_pid, 0)
        if shutdown_signal == signal.SIGTERM:
            # The owner normally creates this process through start(). Keep its
            # real stop path, substituting only our deterministic bridge fixture.
            owner = object.__new__(AgentBridgeProcess)
            owner._process = process
            owner.log = Mock()
            await owner.stop()
        else:
            process.send_signal(shutdown_signal)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=8)
        assert process.returncode == 0, (stdout, stderr)
        assert (tmp_path / "exited").read_text() == "clean"
        assert json.loads((tmp_path / "closed.json").read_text())["child_reaped"] is True
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        if child_pid is not None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGKILL)
