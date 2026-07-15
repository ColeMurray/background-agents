"""Tests for bridge reconnection and error handling logic."""

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
