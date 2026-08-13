"""Tests for code-server restart logic in SandboxSupervisor.monitor_processes."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.supervisor import SandboxSupervisor
from tests.runtime_helpers import make_supervisor


def _make_supervisor() -> SandboxSupervisor:
    return make_supervisor(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        }
    )


def _fake_process(returncode: int | None) -> MagicMock:
    process = MagicMock()
    process.returncode = returncode
    return process


class TestCodeServerMonitorRestart:
    async def test_code_server_crash_does_not_set_shutdown(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        supervisor.access_services._code_server_process = _fake_process(1)

        def restart_side_effect(*_args):
            supervisor.access_services._code_server_process = _fake_process(None)
            supervisor.shutdown_event.set()

        supervisor.access_services.start_code_server = AsyncMock(side_effect=restart_side_effect)
        supervisor._report_fatal_error = AsyncMock()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        supervisor.access_services.start_code_server.assert_called_once()
        supervisor._report_fatal_error.assert_not_called()

    async def test_code_server_restart_exception_is_caught(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        supervisor.access_services._code_server_process = _fake_process(1)
        supervisor.access_services.start_code_server = AsyncMock(
            side_effect=RuntimeError("code-server binary not found")
        )
        iteration = 0

        async def counting_sleep(_delay):
            nonlocal iteration
            iteration += 1
            if iteration >= 2:
                supervisor.shutdown_event.set()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", side_effect=counting_sleep):
            await supervisor.monitor_processes()

        supervisor.access_services.start_code_server.assert_awaited_once()
        assert supervisor.access_services._code_server_process is None

    async def test_code_server_max_restarts_gives_up(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        supervisor.access_services._code_server_process = _fake_process(1)
        supervisor.access_services.start_code_server = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        sleep_count = 0

        async def counting_sleep(_delay):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count > supervisor.MAX_RESTARTS * 3:
                supervisor.shutdown_event.set()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", side_effect=counting_sleep):
            await supervisor.monitor_processes()

        assert supervisor.access_services.start_code_server.call_count == supervisor.MAX_RESTARTS
        assert supervisor.access_services._code_server_process is None
        supervisor._report_fatal_error.assert_not_called()


@pytest.mark.parametrize(
    ("process_attribute", "starter_attribute"),
    [
        ("ttyd_process", "start_ttyd"),
        ("ttyd_proxy_process", "start_ttyd_proxy"),
    ],
)
class TestTerminalMonitorRestart:
    async def test_crash_restarts_nonfatally(self, process_attribute, starter_attribute):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        setattr(supervisor.access_services, f"_{process_attribute}", _fake_process(1))

        def restart_side_effect(*_args):
            setattr(supervisor.access_services, f"_{process_attribute}", _fake_process(None))
            supervisor.shutdown_event.set()

        starter = AsyncMock(side_effect=restart_side_effect)
        setattr(supervisor.access_services, starter_attribute, starter)
        supervisor._report_fatal_error = AsyncMock()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        starter.assert_awaited_once()
        supervisor._report_fatal_error.assert_not_awaited()

    async def test_restart_exception_clears_process(self, process_attribute, starter_attribute):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        setattr(supervisor.access_services, f"_{process_attribute}", _fake_process(1))
        starter = AsyncMock(side_effect=RuntimeError("unavailable"))
        setattr(supervisor.access_services, starter_attribute, starter)
        iteration = 0

        async def counting_sleep(_delay):
            nonlocal iteration
            iteration += 1
            if iteration >= 2:
                supervisor.shutdown_event.set()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", side_effect=counting_sleep):
            await supervisor.monitor_processes()

        starter.assert_awaited_once()
        assert getattr(supervisor.access_services, f"_{process_attribute}") is None

    async def test_max_restarts_abandons_process_nonfatally(
        self, process_attribute, starter_attribute
    ):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(None)
        supervisor.core_services._bridge_process = _fake_process(None)
        setattr(supervisor.access_services, f"_{process_attribute}", _fake_process(1))
        starter = AsyncMock()
        setattr(supervisor.access_services, starter_attribute, starter)
        supervisor._report_fatal_error = AsyncMock()
        sleep_count = 0

        async def counting_sleep(_delay):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count > supervisor.MAX_RESTARTS * 3:
                supervisor.shutdown_event.set()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", side_effect=counting_sleep):
            await supervisor.monitor_processes()

        assert starter.await_count == supervisor.MAX_RESTARTS
        assert getattr(supervisor.access_services, f"_{process_attribute}") is None
        supervisor._report_fatal_error.assert_not_awaited()
