import asyncio
import os
import signal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.entrypoint import SandboxSupervisor


@pytest.fixture
def supervisor():
    with patch("src.sandbox.entrypoint.get_logger"):
        sv = SandboxSupervisor()
        sv.log = MagicMock()
        return sv


@pytest.mark.asyncio
async def test_start_proxy_success(supervisor):
    supervisor.proxy_process = None

    # Mock proxy.mjs existence
    with patch("src.sandbox.entrypoint.Path.exists", return_value=True):
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            mock_process = AsyncMock()
            mock_process.stdout = AsyncMock()
            mock_exec.return_value = mock_process

            await supervisor.start_proxy()

            assert supervisor.proxy_process is not None
            mock_exec.assert_called_once()
            args = mock_exec.call_args[0]
            assert args[0] == "node"
            assert args[1].endswith("proxy.mjs")
            supervisor.log.info.assert_any_call("proxy.started")


@pytest.mark.asyncio
async def test_proxy_crash_restart(supervisor):
    supervisor.proxy_process = AsyncMock()
    supervisor.proxy_process.returncode = 1
    supervisor.MAX_RESTARTS = 3

    with patch.object(supervisor, "start_proxy", new_callable=AsyncMock) as mock_start:
        with patch("asyncio.sleep", new_callable=AsyncMock):
            # We need to simulate one iteration of monitor_processes
            # To avoid infinite loop, we'll set shutdown_event after one check
            async def side_effect(*args, **kwargs):
                supervisor.shutdown_event.set()

            mock_start.side_effect = side_effect

            await supervisor.monitor_processes()

            assert mock_start.called
            supervisor.log.error.assert_any_call(
                "proxy.crash", exit_code=1, restart_count=1
            )


@pytest.mark.asyncio
async def test_proxy_max_restarts(supervisor):
    supervisor.proxy_process = AsyncMock()
    supervisor.proxy_process.returncode = 1
    supervisor.MAX_RESTARTS = 0 # Fail immediately on first crash

    with patch.object(supervisor, "_report_fatal_error", new_callable=AsyncMock) as mock_report:
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

            assert supervisor.shutdown_event.is_set()
            supervisor.log.error.assert_any_call("proxy.max_restarts", restart_count=1)
            mock_report.assert_called_once()


@pytest.mark.asyncio
async def test_shutdown_terminates_proxy(supervisor):
    supervisor.proxy_process = AsyncMock()
    supervisor.proxy_process.returncode = None

    supervisor.bridge_process = AsyncMock()
    supervisor.bridge_process.returncode = None

    supervisor.opencode_process = AsyncMock()
    supervisor.opencode_process.returncode = None

    with patch("asyncio.wait_for", new_callable=AsyncMock):
        await supervisor.shutdown()

        supervisor.proxy_process.terminate.assert_called_once()
        supervisor.log.info.assert_any_call("supervisor.shutdown_start")
