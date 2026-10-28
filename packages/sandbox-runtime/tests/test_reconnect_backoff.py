"""Tests for the bridge's reconnect delay policy."""

import asyncio
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import websockets
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.reconnect_backoff import (
    CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS,
    HEARTBEAT_INTERVAL_SECONDS,
    RECONNECT_BACKOFF_BASE,
    RECONNECT_JITTER_RATIO,
    RECONNECT_MAX_DELAY_SECONDS,
    STABLE_CONNECTION_SECONDS,
    ReconnectBackoff,
)

CONTROL_PLANE_DECISIONS = (
    Path(__file__).resolve().parents[2] / "control-plane/src/sandbox/lifecycle/decisions.ts"
)


def no_jitter() -> float:
    return 0.0


class TestReconnectBackoff:
    def test_delays_grow_exponentially_up_to_the_cap(self):
        backoff = ReconnectBackoff(random_fraction=no_jitter)

        delays = [backoff.next_delay_seconds() for _ in range(6)]

        assert delays == [2.0, 4.0, 8.0, RECONNECT_MAX_DELAY_SECONDS, 15.0, 15.0]

    @pytest.mark.parametrize("drops", [1, 5, 8, 50])
    def test_a_stable_connection_resets_to_the_base_delay(self, drops):
        backoff = ReconnectBackoff(random_fraction=no_jitter)

        for _ in range(drops):
            backoff.next_delay_seconds()
            backoff.connection_ended(STABLE_CONNECTION_SECONDS)

        assert backoff.next_delay_seconds() == RECONNECT_BACKOFF_BASE

    def test_short_connections_keep_backing_off(self):
        backoff = ReconnectBackoff(random_fraction=no_jitter)

        delays = []
        for _ in range(4):
            delays.append(backoff.next_delay_seconds())
            backoff.connection_ended(STABLE_CONNECTION_SECONDS - 0.1)

        assert delays == [2.0, 4.0, 8.0, 15.0]

    def test_a_failed_handshake_does_not_reset(self):
        backoff = ReconnectBackoff(random_fraction=no_jitter)
        backoff.next_delay_seconds()

        backoff.connection_ended(None)

        assert backoff.next_delay_seconds() == 4.0

    def test_jitter_only_shortens_delays(self):
        longest = ReconnectBackoff(random_fraction=lambda: 0.0)
        shortest = ReconnectBackoff(random_fraction=lambda: 0.999999)
        for _ in range(10):
            assert longest.next_delay_seconds() <= RECONNECT_MAX_DELAY_SECONDS

        assert shortest.next_delay_seconds() == pytest.approx(
            RECONNECT_BACKOFF_BASE * (1 - RECONNECT_JITTER_RATIO), abs=1e-5
        )

    def test_a_long_outage_does_not_overflow(self):
        backoff = ReconnectBackoff(random_fraction=no_jitter)

        for _ in range(5000):
            delay = backoff.next_delay_seconds()

        assert delay == RECONNECT_MAX_DELAY_SECONDS


class TestStaleThresholdBudget:
    def test_configured_delays_fit_within_the_stale_threshold(self):
        # Configured delays only: a drop just before a heartbeat was due, then
        # one maximal reconnect wait. Assumes immediate detection and a first
        # attempt that succeeds; detection latency, teardown, the handshake
        # and further failed attempts are not covered.
        assert (
            RECONNECT_MAX_DELAY_SECONDS + HEARTBEAT_INTERVAL_SECONDS
            < CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS
        )

    def test_the_stale_threshold_mirrors_the_control_plane(self):
        if not CONTROL_PLANE_DECISIONS.exists():
            pytest.skip("control-plane sources are not in this checkout")
        match = re.search(
            r"DEFAULT_HEARTBEAT_CONFIG[^{]*\{[^}]*timeoutMs:\s*(\d+)",
            CONTROL_PLANE_DECISIONS.read_text(),
        )
        assert match is not None
        assert int(match.group(1)) / 1000 == CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS


class RecordingBackoff(ReconnectBackoff):
    """Records the policy's delays but never waits on them."""

    def __init__(self) -> None:
        super().__init__(random_fraction=no_jitter)
        self.delays: list[float] = []

    def next_delay_seconds(self) -> float:
        self.delays.append(super().next_delay_seconds())
        return 0.0


class ClosingWs:
    """A connection that stays up for ``uptime_seconds``, then closes.

    A clean close ends the receive loop normally; an abnormal one drops
    without a close frame.
    """

    def __init__(self, bridge: AgentBridge, uptime_seconds: float, *, clean: bool) -> None:
        self._bridge = bridge
        self._uptime_seconds = uptime_seconds
        self._clean = clean
        self.state = State.OPEN
        self.close_code = 1000 if clean else 1006

    async def send(self, data: str) -> None:
        pass

    async def close(self, *_args, **_kwargs):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        # Backdate the connection rather than patching time.monotonic, which
        # the event loop also reads.
        assert self._bridge._connected_at_monotonic is not None
        self._bridge._connected_at_monotonic -= self._uptime_seconds
        self.state = State.CLOSED
        if self._clean:
            raise StopAsyncIteration
        raise websockets.ConnectionClosedError(None, None)


class TestBridgeReconnectBackoff:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("clean", "uptime_seconds", "expected_delays", "stub_disconnect_log"),
        [
            (False, STABLE_CONNECTION_SECONDS * 2, [2.0] * 8, False),
            (False, 1.0, [2.0, 4.0, 8.0, 15.0, 15.0, 15.0, 15.0, 15.0], False),
            # Disconnect logging is diagnostics only; the reset must not depend on it.
            (False, STABLE_CONNECTION_SECONDS * 2, [2.0] * 8, True),
            (True, STABLE_CONNECTION_SECONDS * 2, [2.0] * 8, False),
            # A clean close alone must not reset the backoff of a flapping sandbox.
            (True, 1.0, [2.0, 4.0, 8.0, 15.0, 15.0, 15.0, 15.0, 15.0], False),
        ],
        ids=[
            "abnormal-long-lived",
            "abnormal-short-lived",
            "abnormal-long-lived-without-disconnect-log",
            "clean-long-lived",
            "clean-short-lived",
        ],
    )
    async def test_closes_back_off_only_while_connections_are_short(
        self, monkeypatch, clean, uptime_seconds, expected_delays, stub_disconnect_log
    ):
        backoff = RecordingBackoff()
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="https://example.com",
            auth_token="test-token",
            reconnect_backoff=backoff,
        )
        bridge.log = MagicMock()
        bridge.git_signing.initialize = AsyncMock()
        bridge._load_session_id = AsyncMock()
        bridge.boot_attach.on_connect = AsyncMock()
        if stub_disconnect_log:
            bridge._log_disconnect = MagicMock()

        class ConnectionContext:
            async def __aenter__(self):
                if bridge._connection_count == len(expected_delays):
                    bridge.shutdown_event.set()
                return ClosingWs(bridge, uptime_seconds, clean=clean)

            async def __aexit__(self, *_args):
                return False

        monkeypatch.setattr(
            "sandbox_runtime.bridge.websockets.connect",
            lambda *_args, **_kwargs: ConnectionContext(),
        )

        await asyncio.wait_for(bridge.run(), timeout=5)

        assert backoff.delays == expected_delays
