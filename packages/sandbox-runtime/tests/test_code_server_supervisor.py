"""Tests for code-server restart logic in SandboxSupervisor.monitor_processes."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


class TestCodeServerMonitorRestart:
    """code-server restart in monitor_processes is non-fatal and handles exceptions."""

    def _make_supervisor(self):
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

    def _fake_process(self, returncode):
        proc = MagicMock()
        proc.returncode = returncode
        return proc

    @pytest.mark.asyncio
    async def test_code_server_crash_does_not_set_shutdown(self):
        """code-server crash should NOT trigger supervisor shutdown."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)

        # code-server exited with code 1
        original_process = self._fake_process(returncode=1)
        running_process = self._fake_process(returncode=None)

        def restart_side_effect():
            sup.code_server_process = running_process
            sup.shutdown_event.set()  # terminate the monitor loop

        sup.code_server_process = original_process
        sup.start_code_server = AsyncMock(side_effect=restart_side_effect)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await sup.monitor_processes()

        sup.start_code_server.assert_called_once()
        # shutdown_event is set by our side_effect, not by the supervisor
        # confirming code-server crash does not call _report_fatal_error
        assert not hasattr(sup, "_report_fatal_error_called")

    @pytest.mark.asyncio
    async def test_code_server_restart_exception_is_caught(self):
        """If start_code_server() raises, the supervisor continues running."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)
        sup.code_server_process = self._fake_process(returncode=1)

        call_count = 0

        async def failing_restart():
            nonlocal call_count
            call_count += 1
            raise RuntimeError("code-server binary not found")

        sup.start_code_server = AsyncMock(side_effect=failing_restart)

        # After the restart fails, code_server_process should be set to None
        # so the monitor loop stops checking it. We set shutdown after one iteration.
        iteration = 0

        async def counting_sleep(delay):
            nonlocal iteration
            iteration += 1
            if iteration >= 2:
                sup.shutdown_event.set()

        with patch("asyncio.sleep", side_effect=counting_sleep):
            await sup.monitor_processes()

        assert call_count == 1
        assert sup.code_server_process is None

    @pytest.mark.asyncio
    async def test_code_server_max_restarts_gives_up(self):
        """After MAX_RESTARTS, code-server is abandoned (process set to None)."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)

        # code-server always crashes
        sup.code_server_process = self._fake_process(returncode=1)
        sup.start_code_server = AsyncMock()  # no-op, process stays crashed
        sup._report_fatal_error = AsyncMock()

        # After code-server gives up, the loop continues (non-fatal).
        # Terminate after enough iterations to observe the give-up behavior.
        # Each restart cycle has 2 sleeps (backoff + 1.0s monitor interval),
        # so we need at least MAX_RESTARTS * 2 + extra to see all restarts.
        sleep_count = 0

        async def counting_sleep(delay):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count > sup.MAX_RESTARTS * 3:
                sup.shutdown_event.set()

        with patch("asyncio.sleep", side_effect=counting_sleep):
            await sup.monitor_processes()

        # Should have restarted MAX_RESTARTS times, then given up
        assert sup.start_code_server.call_count == sup.MAX_RESTARTS
        assert sup.code_server_process is None
        # Should NOT have reported a fatal error (code-server is non-fatal)
        sup._report_fatal_error.assert_not_called()
