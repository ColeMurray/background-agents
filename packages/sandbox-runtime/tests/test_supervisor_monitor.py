"""Tests for SandboxSupervisor.monitor_processes bridge restart logic."""

from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.supervisor import SandboxSupervisor
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


def _fake_process(returncode: int | None) -> MagicMock:
    proc = MagicMock()
    proc.returncode = returncode
    return proc


class TestBridgeGracefulShutdown:
    async def test_bridge_exit_0_sets_shutdown_event(self):
        supervisor = _make_supervisor()
        supervisor.core_services._bridge_process = _fake_process(returncode=0)
        supervisor.core_services._opencode_process = _fake_process(returncode=None)

        await supervisor.monitor_processes()

        assert supervisor.shutdown_event.is_set()

    async def test_bridge_exit_0_does_not_restart(self):
        supervisor = _make_supervisor()
        supervisor.core_services._bridge_process = _fake_process(returncode=0)
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        supervisor.core_services.start_bridge = AsyncMock()

        await supervisor.monitor_processes()

        supervisor.core_services.start_bridge.assert_not_called()


class TestBridgeCrashRestart:
    async def test_bridge_crash_restarts_with_backoff(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        supervisor._report_fatal_error = AsyncMock()
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.core_services._bridge_process = running_process
            supervisor.shutdown_event.set()

        supervisor.core_services._bridge_process = _fake_process(returncode=1)
        supervisor.core_services.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        supervisor.core_services.start_bridge.assert_called_once()
        supervisor._report_fatal_error.assert_not_called()

    async def test_bridge_crash_exceeds_max_restarts(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        supervisor.core_services._bridge_process = _fake_process(returncode=1)
        supervisor.core_services.start_bridge = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        assert supervisor.shutdown_event.is_set()
        assert supervisor.core_services.start_bridge.call_count == supervisor.MAX_RESTARTS
        supervisor._report_fatal_error.assert_called_once()
        assert "Bridge crashed" in supervisor._report_fatal_error.call_args[0][0]

    async def test_bridge_killed_by_signal_restarts(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.core_services._bridge_process = running_process
            supervisor.shutdown_event.set()

        supervisor.core_services._bridge_process = _fake_process(returncode=-15)
        supervisor.core_services.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        supervisor.core_services.start_bridge.assert_called_once()


class TestBridgeBackoffTiming:
    async def test_first_restart_uses_base_delay(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            supervisor.core_services._bridge_process = running_process
            supervisor.shutdown_event.set()

        supervisor.core_services._bridge_process = _fake_process(returncode=1)
        supervisor.core_services.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock) as sleep:
            await supervisor.monitor_processes()

        sleep.assert_any_call(supervisor.BACKOFF_BASE**1)

    async def test_backoff_is_capped_at_max(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=None)
        supervisor.core_services._bridge_process = _fake_process(returncode=1)
        supervisor.core_services.start_bridge = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        sleep_delays = []

        async def capture_sleep(delay):
            sleep_delays.append(delay)

        with patch("sandbox_runtime.supervisor.asyncio.sleep", side_effect=capture_sleep):
            await supervisor.monitor_processes()

        assert all(delay <= supervisor.BACKOFF_MAX for delay in sleep_delays)


class TestOpenCodeCrashRestart:
    async def test_opencode_crash_exceeds_max_restarts(self):
        supervisor = _make_supervisor()
        supervisor.core_services._opencode_process = _fake_process(returncode=1)
        supervisor.core_services.start_opencode = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch("sandbox_runtime.supervisor.asyncio.sleep", new_callable=AsyncMock):
            await supervisor.monitor_processes()

        assert supervisor.core_services.start_opencode.call_count == supervisor.MAX_RESTARTS
        supervisor._report_fatal_error.assert_called_once()
        assert "OpenCode crashed" in supervisor._report_fatal_error.call_args.args[0]


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
