"""Tests for code-server restart logic in SandboxSupervisor.monitor_processes."""

from unittest.mock import AsyncMock, MagicMock, patch

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
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.code_server._process = _fake_process(1)

        def restart_side_effect(*_args):
            supervisor.code_server._process = _fake_process(None)
            supervisor.shutdown_event.set()

        supervisor.code_server.start = AsyncMock(side_effect=restart_side_effect)
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        supervisor.code_server.start.assert_called_once()
        supervisor._report_fatal_error.assert_not_called()

    async def test_code_server_restart_exception_is_caught(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.code_server._process = _fake_process(1)
        supervisor.code_server.start = AsyncMock(
            side_effect=RuntimeError("code-server binary not found")
        )
        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(side_effect=[False, True])):
            await supervisor.monitor_processes()

        supervisor.code_server.start.assert_awaited_once()
        assert supervisor.code_server._process is None

    async def test_code_server_max_restarts_gives_up(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.code_server._process = _fake_process(1)
        supervisor.code_server.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        with patch.object(
            supervisor,
            "_wait_for_shutdown",
            AsyncMock(side_effect=[False] * (supervisor.MAX_RESTARTS * 2) + [True]),
        ):
            await supervisor.monitor_processes()

        assert supervisor.code_server.start.call_count == supervisor.MAX_RESTARTS
        assert supervisor.code_server._process is None
        supervisor._report_fatal_error.assert_not_called()


class TestTerminalMonitorRestart:
    async def test_either_component_crash_restarts_whole_stack_nonfatally(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.web_terminal._proxy_process = _fake_process(1)
        supervisor.web_terminal._ttyd_process = _fake_process(None)
        supervisor.web_terminal.stop = AsyncMock()

        def restart_side_effect(*_args):
            supervisor.web_terminal._proxy_process = _fake_process(None)
            supervisor.shutdown_event.set()

        supervisor.web_terminal.start = AsyncMock(side_effect=restart_side_effect)
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        supervisor.web_terminal.stop.assert_awaited_once()
        supervisor.web_terminal.start.assert_awaited_once()
        supervisor._report_fatal_error.assert_not_awaited()

    async def test_restart_exception_stops_whole_stack(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.web_terminal._ttyd_process = _fake_process(1)
        supervisor.web_terminal.stop = AsyncMock(
            side_effect=lambda: setattr(supervisor.web_terminal, "_ttyd_process", None)
        )
        supervisor.web_terminal.start = AsyncMock(side_effect=RuntimeError("unavailable"))
        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(side_effect=[False, True])):
            await supervisor.monitor_processes()

        supervisor.web_terminal.start.assert_awaited_once()
        assert supervisor.web_terminal.stop.await_count == 2

    async def test_max_restarts_abandons_stack_nonfatally(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.web_terminal._ttyd_process = _fake_process(1)
        supervisor.web_terminal.start = AsyncMock()

        async def stop_terminal():
            if supervisor.web_terminal.start.await_count >= supervisor.MAX_RESTARTS:
                supervisor.web_terminal._ttyd_process = None
                supervisor.shutdown_event.set()

        supervisor.web_terminal.stop = AsyncMock(side_effect=stop_terminal)
        supervisor._report_fatal_error = AsyncMock()
        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        assert supervisor.web_terminal.start.await_count == supervisor.MAX_RESTARTS
        assert supervisor.web_terminal.stop.await_count == supervisor.MAX_RESTARTS + 1
        supervisor._report_fatal_error.assert_not_awaited()

    async def test_code_server_shutdown_during_backoff_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.code_server._process = _fake_process(1)
        supervisor.code_server.start = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=True)):
            await supervisor.monitor_processes()

        supervisor.code_server.start.assert_not_called()

    async def test_terminal_shutdown_during_backoff_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(None)
        supervisor.agent_bridge._process = _fake_process(None)
        supervisor.web_terminal._ttyd_process = _fake_process(1)
        supervisor.web_terminal.stop = AsyncMock()
        supervisor.web_terminal.start = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=True)):
            await supervisor.monitor_processes()

        supervisor.web_terminal.stop.assert_awaited_once()
        supervisor.web_terminal.start.assert_not_called()
