"""Tests for SandboxSupervisor.monitor_processes bridge restart logic."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from sandbox_runtime.supervisor import FATAL_ERROR_REPORT_MAX_CHARS, SandboxSupervisor
from tests.runtime_helpers import make_supervisor


def _make_supervisor() -> SandboxSupervisor:
    return make_supervisor(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        }
    )


def _make_reporting_supervisor() -> SandboxSupervisor:
    return make_supervisor(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com/",
            "SANDBOX_AUTH_TOKEN": "tok",
            "SESSION_CONFIG": '{"session_id":"session/one"}',
        }
    )


def _fake_process(returncode: int | None) -> MagicMock:
    proc = MagicMock()
    proc.returncode = returncode
    return proc


class TestBridgeGracefulShutdown:
    async def test_bridge_exit_0_sets_shutdown_event(self):
        supervisor = _make_supervisor()
        supervisor.agent_bridge._process = _fake_process(returncode=0)
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)

        await supervisor.monitor_processes()

        assert supervisor.shutdown_event.is_set()

    async def test_bridge_exit_0_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.agent_bridge._process = _fake_process(returncode=0)
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        supervisor.agent_bridge.start = AsyncMock()

        await supervisor.monitor_processes()

        supervisor.agent_bridge.start.assert_not_called()

    async def test_stop_tolerates_process_exiting_before_terminate(self):
        supervisor = _make_supervisor()
        process = _fake_process(returncode=None)
        process.terminate.side_effect = ProcessLookupError
        process.wait = AsyncMock(return_value=0)
        supervisor.agent_bridge._process = process

        await supervisor.agent_bridge.stop()

        process.wait.assert_awaited_once()


class TestFatalErrorHttpReporting:
    async def test_posts_to_session_scoped_sandbox_error_endpoint(self):
        supervisor = _make_reporting_supervisor()
        message = "prefix" + "x" * FATAL_ERROR_REPORT_MAX_CHARS
        client = AsyncMock()
        response = MagicMock(spec=httpx.Response)
        client.post.return_value = response
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with patch("sandbox_runtime.supervisor.httpx.AsyncClient", return_value=client_context):
            await supervisor._report_fatal_error(message)

        client.post.assert_awaited_once_with(
            "https://cp.example.com/sessions/session%2Fone/sandbox-error",
            json={"error": "x" * FATAL_ERROR_REPORT_MAX_CHARS, "fatal": True},
            headers={"Authorization": "Bearer tok", "X-Sandbox-ID": "test-sandbox"},
            timeout=5.0,
        )
        response.raise_for_status.assert_called_once_with()

    async def test_logs_non_successful_report_response(self, caplog):
        supervisor = _make_reporting_supervisor()
        client = AsyncMock()
        client.post.return_value = httpx.Response(
            503,
            request=httpx.Request(
                "POST", "https://cp.example.com/sessions/session-1/sandbox-error"
            ),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        sleep = AsyncMock()

        caplog.set_level("ERROR", logger="supervisor")
        with (
            patch("sandbox_runtime.supervisor.httpx.AsyncClient", return_value=client_context),
            patch("sandbox_runtime.supervisor.asyncio.sleep", sleep),
        ):
            await supervisor._report_fatal_error("Bridge repeatedly crashed")

        assert client.post.await_count == 3
        assert [call.args[0] for call in sleep.await_args_list] == [2, 4]
        assert any(
            record.getMessage() == "supervisor.report_error_failed" for record in caplog.records
        )

    async def test_skips_control_plane_report_without_session_id(self):
        supervisor = make_supervisor(
            {
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
                "SESSION_CONFIG": "{}",
            }
        )

        with patch("sandbox_runtime.supervisor.httpx.AsyncClient") as client:
            await supervisor._report_fatal_error("Build failed")

        client.assert_not_called()


class TestBridgeCrashRestart:
    async def test_bridge_crash_restarts_with_backoff(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        supervisor._report_fatal_error = AsyncMock()
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.agent_bridge._process = running_process
            supervisor.shutdown_event.set()

        supervisor.agent_bridge._process = _fake_process(returncode=1)
        supervisor.agent_bridge.start = AsyncMock(side_effect=restart_side_effect)

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        supervisor.agent_bridge.start.assert_called_once()
        supervisor._report_fatal_error.assert_not_called()

    async def test_bridge_crash_exceeds_max_restarts(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        supervisor.agent_bridge._process = _fake_process(returncode=1)
        supervisor.agent_bridge.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        assert supervisor.shutdown_event.is_set()
        assert supervisor.agent_bridge.start.call_count == supervisor.MAX_RESTARTS
        supervisor._report_fatal_error.assert_called_once()
        assert "Bridge crashed" in supervisor._report_fatal_error.call_args[0][0]

    async def test_bridge_killed_by_signal_restarts(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.agent_bridge._process = running_process
            supervisor.shutdown_event.set()

        supervisor.agent_bridge._process = _fake_process(returncode=-15)
        supervisor.agent_bridge.start = AsyncMock(side_effect=restart_side_effect)

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        supervisor.agent_bridge.start.assert_called_once()


class TestBridgeBackoffTiming:
    async def test_first_restart_uses_base_delay(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.agent_bridge._process = running_process
            supervisor.shutdown_event.set()

        supervisor.agent_bridge._process = _fake_process(returncode=1)
        supervisor.agent_bridge.start = AsyncMock(side_effect=restart_side_effect)

        with patch.object(
            supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)
        ) as wait_for_shutdown:
            await supervisor.monitor_processes()

        wait_for_shutdown.assert_any_await(supervisor.BACKOFF_BASE**1)

    async def test_backoff_is_capped_at_max(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        supervisor.agent_bridge._process = _fake_process(returncode=1)
        supervisor.agent_bridge.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        sleep_delays = []

        async def capture_wait(delay):
            sleep_delays.append(delay)
            return False

        with patch.object(supervisor, "_wait_for_shutdown", side_effect=capture_wait):
            await supervisor.monitor_processes()

        assert all(delay <= supervisor.BACKOFF_MAX for delay in sleep_delays)


class TestOpenCodeCrashRestart:
    async def test_opencode_crash_exceeds_max_restarts(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=1)
        supervisor.opencode_server.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            await supervisor.monitor_processes()

        assert supervisor.opencode_server.start.call_count == supervisor.MAX_RESTARTS
        supervisor._report_fatal_error.assert_called_once()
        assert "OpenCode crashed" in supervisor._report_fatal_error.call_args.args[0]

    async def test_opencode_shutdown_during_backoff_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=1)
        supervisor.opencode_server.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=True)):
            await supervisor.monitor_processes()

        supervisor.opencode_server.start.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    async def test_real_shutdown_event_interrupts_opencode_backoff(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=1)
        supervisor.opencode_server.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        monitor_task = asyncio.create_task(supervisor.monitor_processes())
        await asyncio.sleep(0)
        supervisor.shutdown_event.set()
        await asyncio.wait_for(monitor_task, timeout=0.5)

        supervisor.opencode_server.start.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    async def test_bridge_shutdown_during_backoff_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.opencode_server._opencode_process = _fake_process(returncode=None)
        supervisor.agent_bridge._process = _fake_process(returncode=1)
        supervisor.agent_bridge.start = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=True)):
            await supervisor.monitor_processes()

        supervisor.agent_bridge.start.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()


class TestFatalErrorReporting:
    async def test_report_fatal_error_logs_without_reserved_field_collision(self, caplog):
        supervisor = _make_supervisor()

        caplog.set_level("ERROR", logger="supervisor")
        await supervisor._report_fatal_error("boom")

        fatal_records = [
            record for record in caplog.records if record.getMessage() == "supervisor.fatal"
        ]
        assert len(fatal_records) == 1
        assert fatal_records[0].error_message == "boom"
