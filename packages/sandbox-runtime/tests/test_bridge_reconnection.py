"""Tests for bridge reconnection and error handling logic."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge, SessionTerminatedError
from sandbox_runtime.git_signing import GitSigningError


class TestIsFatalConnectionError:
    """Tests for _is_fatal_connection_error method."""

    @pytest.fixture
    def bridge(self):
        return AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="https://example.com",
            auth_token="test-token",
        )

    def test_http_410_is_fatal(self, bridge):
        error_str = "server rejected WebSocket connection: HTTP 410"
        assert bridge._is_fatal_connection_error(error_str) is True

    def test_http_401_is_fatal(self, bridge):
        error_str = "server rejected WebSocket connection: HTTP 401"
        assert bridge._is_fatal_connection_error(error_str) is True

    def test_http_403_is_fatal(self, bridge):
        error_str = "server rejected WebSocket connection: HTTP 403"
        assert bridge._is_fatal_connection_error(error_str) is True

    def test_http_404_is_fatal(self, bridge):
        error_str = "server rejected WebSocket connection: HTTP 404"
        assert bridge._is_fatal_connection_error(error_str) is True

    def test_http_500_is_not_fatal(self, bridge):
        error_str = "server rejected WebSocket connection: HTTP 500"
        assert bridge._is_fatal_connection_error(error_str) is False

    def test_network_error_is_not_fatal(self, bridge):
        error_str = "Connection refused"
        assert bridge._is_fatal_connection_error(error_str) is False

    def test_timeout_is_not_fatal(self, bridge):
        error_str = "Connection timed out"
        assert bridge._is_fatal_connection_error(error_str) is False

    def test_empty_string_is_not_fatal(self, bridge):
        assert bridge._is_fatal_connection_error("") is False

    def test_connection_aggregate_fields_track_lifetime_and_reconnects(self, bridge):
        bridge._reconnect_attempt_count = 2

        bridge._mark_connected(now_monotonic=10.0)
        first = bridge._finalize_connection(now_monotonic=13.25)

        bridge._mark_connected(now_monotonic=20.0)
        second = bridge._finalize_connection(now_monotonic=21.5)

        assert first == {
            "connection_duration_seconds": 3.25,
            "total_connected_duration_seconds": 3.25,
            "connection_count": 1,
            "reconnect_count": 0,
            "reconnect_attempt_count": 2,
        }
        assert second == {
            "connection_duration_seconds": 1.5,
            "total_connected_duration_seconds": 4.75,
            "connection_count": 2,
            "reconnect_count": 1,
            "reconnect_attempt_count": 2,
        }

    def test_finalize_connection_returns_none_without_active_connection(self, bridge):
        assert bridge._finalize_connection(now_monotonic=5.0) is None

    @pytest.mark.asyncio
    async def test_pre_loop_cancellation_cleans_up_connection_state(self, bridge, monkeypatch):
        class ConnectionContext:
            def __init__(self, ws):
                self.ws = ws

            async def __aenter__(self):
                return self.ws

            async def __aexit__(self, *_args):
                return False

        ws = MagicMock(close_code=None)
        monkeypatch.setattr(
            "sandbox_runtime.bridge.websockets.connect",
            lambda *_args, **_kwargs: ConnectionContext(ws),
        )
        bridge.log = MagicMock()
        bridge._send_event = AsyncMock(side_effect=asyncio.CancelledError)

        with pytest.raises(asyncio.CancelledError):
            await bridge._connect_and_run()

        assert bridge.ws is None
        assert bridge._connected_at_monotonic is None
        bridge.log.info.assert_any_call(
            "bridge.disconnect",
            reason="connection_closed",
            connection_duration_seconds=pytest.approx(0, abs=0.1),
            total_connected_duration_seconds=pytest.approx(0, abs=0.1),
            connection_count=1,
            reconnect_count=0,
            reconnect_attempt_count=0,
        )

    @pytest.mark.asyncio
    async def test_run_complete_does_not_retain_transient_outcome(self, bridge):
        attempts = 0

        async def connect_and_run():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary failure")
            bridge.shutdown_event.set()

        bridge.log = MagicMock()
        bridge.git_signing.initialize = AsyncMock()
        bridge._load_session_id = AsyncMock()
        bridge._connect_and_run = connect_and_run
        bridge.RECONNECT_BACKOFF_BASE = 0

        await bridge.run()

        bridge.log.info.assert_any_call(
            "bridge.run_complete",
            outcome="shutdown",
            connection_count=0,
            reconnect_count=0,
            reconnect_attempt_count=1,
            total_connected_duration_seconds=0.0,
        )

    @pytest.mark.asyncio
    async def test_run_retries_signing_initialization_before_connecting(self, bridge):
        async def connect_and_run():
            bridge.shutdown_event.set()

        bridge.log = MagicMock()
        bridge.git_signing.initialize = AsyncMock(
            side_effect=[
                GitSigningError("Commit signing configuration unavailable", retryable=True),
                None,
            ]
        )
        bridge._load_session_id = AsyncMock()
        bridge._connect_and_run = AsyncMock(side_effect=connect_and_run)
        bridge.RECONNECT_BACKOFF_BASE = 0

        await bridge.run()

        assert bridge.git_signing.initialize.await_count == 2
        bridge._connect_and_run.assert_awaited_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [401, 403, 404, 410])
    async def test_run_fails_deterministically_on_terminal_signing_configuration_status(
        self, bridge, monkeypatch, tmp_path, status
    ):
        fatal_path = tmp_path / "fatal.txt"
        monkeypatch.setattr("sandbox_runtime.bridge.BRIDGE_FATAL_ERROR_FILE_PATH", str(fatal_path))
        bridge.log = MagicMock()
        bridge.git_signing.initialize = AsyncMock(
            side_effect=GitSigningError(
                "Commit signing configuration unavailable", status_code=status
            )
        )
        bridge._load_session_id = AsyncMock()
        bridge._connect_and_run = AsyncMock()
        sleep = AsyncMock()
        monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)

        with pytest.raises(GitSigningError, match="Commit signing configuration unavailable"):
            await bridge.run()

        bridge._connect_and_run.assert_not_awaited()
        sleep.assert_not_awaited()
        assert fatal_path.read_text() == "Commit signing configuration unavailable"
        bridge.log.info.assert_any_call(
            "bridge.run_complete",
            outcome="fatal_error",
            connection_count=0,
            reconnect_count=0,
            reconnect_attempt_count=0,
            total_connected_duration_seconds=0.0,
        )

    @pytest.mark.asyncio
    async def test_run_fails_deterministically_on_nonretryable_payload_failure(
        self, bridge, monkeypatch, tmp_path
    ):
        fatal_path = tmp_path / "fatal.txt"
        monkeypatch.setattr("sandbox_runtime.bridge.BRIDGE_FATAL_ERROR_FILE_PATH", str(fatal_path))
        bridge.log = MagicMock()
        bridge.git_signing.initialize = AsyncMock(
            side_effect=GitSigningError("Invalid commit signing configuration")
        )
        bridge._load_session_id = AsyncMock()
        bridge._connect_and_run = AsyncMock()
        sleep = AsyncMock()
        monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)

        with pytest.raises(GitSigningError, match="Invalid commit signing configuration"):
            await bridge.run()

        bridge._connect_and_run.assert_not_awaited()
        sleep.assert_not_awaited()
        assert fatal_path.read_text() == "Invalid commit signing configuration"


class WedgedWs:
    """A peer that stopped reading.

    Sends park in flow control forever and the socket never closes itself, so
    only aborting the transport can end the receive loop.
    """

    def __init__(self):
        self.state = State.OPEN
        self.close_code = 1006
        self.receiving = asyncio.Event()
        self.transport = SimpleNamespace(abort=self._abort)
        self._ended = asyncio.Event()

    def _abort(self) -> None:
        self.state = State.CLOSED
        self._ended.set()

    async def send(self, data: str) -> None:
        await asyncio.Event().wait()

    async def close(self, *_args, **_kwargs):
        self._ended.set()

    def __aiter__(self):
        self.receiving.set()
        return self

    async def __anext__(self):
        await self._ended.wait()
        raise StopAsyncIteration


class TestStalledWriteReconnect:
    """The boundary the forwarder's retirement exists to cross.

    A wedged connection stays OPEN, so the receive loop that drives reconnects
    never ends on its own. Retiring the connection has to end it.
    """

    @pytest.fixture
    def bridge(self):
        return AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="https://example.com",
            auth_token="test-token",
        )

    @pytest.mark.asyncio
    async def test_a_stalled_write_ends_the_receive_loop_so_the_run_loop_reconnects(
        self, bridge, monkeypatch
    ):
        class ConnectionContext:
            def __init__(self, ws):
                self.ws = ws

            async def __aenter__(self):
                return self.ws

            async def __aexit__(self, *_args):
                return False

        ws = WedgedWs()
        monkeypatch.setattr(
            "sandbox_runtime.bridge.websockets.connect",
            lambda *_args, **_kwargs: ConnectionContext(ws),
        )
        bridge.log = MagicMock()
        bridge.boot_attach.on_connect = AsyncMock()
        bridge.event_forwarder._send_timeout_seconds = 0.05

        connect_task = asyncio.create_task(bridge._connect_and_run())
        await asyncio.wait_for(ws.receiving.wait(), timeout=1)

        # A heartbeat into a peer that stopped reading.
        assert await bridge._send_event({"type": "heartbeat"}) is False

        # Without retirement this never returns, and run() never reconnects.
        await asyncio.wait_for(connect_task, timeout=1)

        assert ws.state is State.CLOSED
        assert bridge.ws is None
        assert bridge.event_forwarder._ws is None


class TestSessionTerminatedError:
    """Tests for SessionTerminatedError exception."""

    def test_can_be_raised_and_caught(self):
        with pytest.raises(SessionTerminatedError) as exc_info:
            raise SessionTerminatedError("Test message")
        assert "Test message" in str(exc_info.value)

    def test_exception_chaining(self):
        original = ValueError("original error")
        with pytest.raises(SessionTerminatedError) as exc_info:
            raise SessionTerminatedError("Wrapped") from original
        assert exc_info.value.__cause__ is original
