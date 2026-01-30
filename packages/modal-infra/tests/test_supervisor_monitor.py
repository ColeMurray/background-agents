"""Tests for SandboxSupervisor.monitor_processes bridge restart logic."""

from unittest.mock import AsyncMock, MagicMock, patch

from src.sandbox.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with env vars stubbed out."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


def _fake_process(returncode: int | None) -> MagicMock:
    """Return a mock process with the given returncode."""
    proc = MagicMock()
    proc.returncode = returncode
    return proc


class TestBridgeGracefulShutdown:
    """Bridge exit code 0 should propagate shutdown, not restart."""

    async def test_bridge_exit_0_sets_shutdown_event(self):
        sup = _make_supervisor()
        sup.bridge_process = _fake_process(returncode=0)
        # OpenCode still running
        sup.opencode_process = _fake_process(returncode=None)

        await sup.monitor_processes()

        assert sup.shutdown_event.is_set()

    async def test_bridge_exit_0_does_not_restart(self):
        sup = _make_supervisor()
        sup.bridge_process = _fake_process(returncode=0)
        sup.opencode_process = _fake_process(returncode=None)
        sup.start_bridge = AsyncMock()

        await sup.monitor_processes()

        sup.start_bridge.assert_not_called()


class TestBridgeCrashRestart:
    """Non-zero bridge exit should restart with backoff up to MAX_RESTARTS."""

    async def test_bridge_crash_restarts_with_backoff(self):
        sup = _make_supervisor()
        sup.opencode_process = _fake_process(returncode=None)
        sup.start_bridge = AsyncMock()
        sup._report_fatal_error = AsyncMock()

        # Simulate: first check returns exit code 1, after restart returns None (running)
        original_process = _fake_process(returncode=1)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            sup.bridge_process = running_process
            # After one restart, trigger shutdown so the test terminates
            sup.shutdown_event.set()

        sup.bridge_process = original_process
        sup.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await sup.monitor_processes()

        sup.start_bridge.assert_called_once()
        sup._report_fatal_error.assert_not_called()

    async def test_bridge_crash_exceeds_max_restarts(self):
        sup = _make_supervisor()
        sup.opencode_process = _fake_process(returncode=None)
        sup._report_fatal_error = AsyncMock()

        # Bridge always returns exit code 1 (keeps crashing)
        sup.bridge_process = _fake_process(returncode=1)
        sup.start_bridge = AsyncMock()  # no-op, bridge_process stays with returncode=1

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await sup.monitor_processes()

        assert sup.shutdown_event.is_set()
        assert sup.start_bridge.call_count == sup.MAX_RESTARTS
        sup._report_fatal_error.assert_called_once()
        assert "Bridge crashed" in sup._report_fatal_error.call_args[0][0]

    async def test_bridge_killed_by_signal_restarts(self):
        """Negative exit codes (killed by signal) should trigger restart."""
        sup = _make_supervisor()
        sup.opencode_process = _fake_process(returncode=None)

        original_process = _fake_process(returncode=-15)  # SIGTERM
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            sup.bridge_process = running_process
            sup.shutdown_event.set()

        sup.bridge_process = original_process
        sup.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await sup.monitor_processes()

        sup.start_bridge.assert_called_once()


class TestBridgeBackoffTiming:
    """Verify exponential backoff delays."""

    async def test_first_restart_uses_base_delay(self):
        sup = _make_supervisor()
        sup.opencode_process = _fake_process(returncode=None)

        original_process = _fake_process(returncode=1)
        running_process = _fake_process(returncode=None)

        def restart_side_effect():
            sup.bridge_process = running_process
            sup.shutdown_event.set()

        sup.bridge_process = original_process
        sup.start_bridge = AsyncMock(side_effect=restart_side_effect)

        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await sup.monitor_processes()

        # First restart: delay = BACKOFF_BASE ** 1 = 2.0
        mock_sleep.assert_any_call(sup.BACKOFF_BASE**1)

    async def test_backoff_is_capped_at_max(self):
        sup = _make_supervisor()
        sup.opencode_process = _fake_process(returncode=None)
        sup._report_fatal_error = AsyncMock()

        # Bridge keeps crashing until max restarts
        sup.bridge_process = _fake_process(returncode=1)
        sup.start_bridge = AsyncMock()

        sleep_delays = []

        async def capture_sleep(delay):
            sleep_delays.append(delay)

        with patch("asyncio.sleep", side_effect=capture_sleep):
            await sup.monitor_processes()

        # All delays should be <= BACKOFF_MAX
        for delay in sleep_delays:
            assert delay <= sup.BACKOFF_MAX
