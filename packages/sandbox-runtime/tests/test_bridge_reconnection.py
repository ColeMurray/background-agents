"""Tests for bridge reconnection and error handling logic."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge, SessionTerminatedError


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
    async def test_run_complete_does_not_retain_transient_outcome(self, bridge, monkeypatch):
        class HttpClient:
            async def aclose(self):
                return None

        attempts = 0

        async def connect_and_run():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary failure")
            bridge.shutdown_event.set()

        bridge.log = MagicMock()
        bridge._load_session_id = AsyncMock()
        bridge._connect_and_run = connect_and_run
        monkeypatch.setattr(
            "sandbox_runtime.bridge.httpx.AsyncClient", lambda **_kwargs: HttpClient()
        )
        monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", AsyncMock())

        await bridge.run()

        bridge.log.info.assert_any_call(
            "bridge.run_complete",
            outcome="shutdown",
            connection_count=0,
            reconnect_count=0,
            reconnect_attempt_count=1,
            total_connected_duration_seconds=0.0,
        )


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


class TestWebSocketUrl:
    """Tests for the bridge WebSocket URL contract."""

    def test_includes_url_encoded_sandbox_id_in_query(self):
        bridge = AgentBridge(
            sandbox_id="sandbox/name with spaces",
            session_id="test-session",
            control_plane_url="https://example.com",
            auth_token="test-token",
        )

        assert (
            bridge.ws_url
            == "wss://example.com/sessions/test-session/ws?type=sandbox&sandbox_id=sandbox%2Fname%20with%20spaces"
        )
