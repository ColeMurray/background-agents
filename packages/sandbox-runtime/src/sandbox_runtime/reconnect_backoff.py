"""Reconnect timing for the bridge's control-plane WebSocket.

The control plane marks a sandbox stale when no heartbeat arrives for
``CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS``; a successful reattach refreshes
that liveness. These constants share a configured-delay budget:
``HEARTBEAT_INTERVAL_SECONDS + RECONNECT_MAX_DELAY_SECONDS`` must stay below
the stale threshold. That sum covers a drop just before a heartbeat was due,
followed by one maximal reconnect wait.

The budget is not an end-to-end recovery bound. It assumes the drop is seen at
once and the next attempt succeeds. Failure detection (up to the next ping or
heartbeat), teardown, the handshake and any further failed attempts are not
counted; they have only the margin left under the threshold.
"""

from __future__ import annotations

import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

# Mirrors DEFAULT_HEARTBEAT_CONFIG.timeoutMs in
# packages/control-plane/src/sandbox/lifecycle/decisions.ts. Must exceed
# RECONNECT_MAX_DELAY_SECONDS + HEARTBEAT_INTERVAL_SECONDS.
CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS = 90.0
# Together with RECONNECT_MAX_DELAY_SECONDS, must stay below
# CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS.
HEARTBEAT_INTERVAL_SECONDS = 30.0
RECONNECT_BACKOFF_BASE = 2.0
# Together with HEARTBEAT_INTERVAL_SECONDS, must stay below
# CONTROL_PLANE_HEARTBEAT_TIMEOUT_SECONDS. Jitter only shortens delays, so
# this is the longest a reconnect ever waits.
RECONNECT_MAX_DELAY_SECONDS = 15.0
# Each delay is scaled into [1 - ratio, 1] of its backoff value, so sandboxes
# dropped by the same network event do not reconnect in lockstep.
RECONNECT_JITTER_RATIO = 0.5
# A connection that stayed up this long was healthy, so however it ended the
# next reconnect starts from the base delay. Shorter ones keep backing off,
# which protects the control plane from a flapping sandbox.
STABLE_CONNECTION_SECONDS = 30.0
_MAX_BACKOFF_EXPONENT = 32


class ReconnectBackoff:
    """Exponential, jittered reconnect delays that reset after a stable connection."""

    def __init__(
        self,
        *,
        base: float = RECONNECT_BACKOFF_BASE,
        max_delay_seconds: float = RECONNECT_MAX_DELAY_SECONDS,
        jitter_ratio: float = RECONNECT_JITTER_RATIO,
        stable_connection_seconds: float = STABLE_CONNECTION_SECONDS,
        random_fraction: Callable[[], float] = random.random,
    ) -> None:
        self._base = base
        self._max_delay_seconds = max_delay_seconds
        self._jitter_ratio = jitter_ratio
        self._stable_connection_seconds = stable_connection_seconds
        self._random_fraction = random_fraction
        self.attempt = 0

    def connection_ended(self, connection_duration_seconds: float | None) -> None:
        """Record how long the last connection stayed up (None if it never opened)."""
        if (
            connection_duration_seconds is not None
            and connection_duration_seconds >= self._stable_connection_seconds
        ):
            self.attempt = 0

    def next_delay_seconds(self) -> float:
        """Advance to the next attempt and return how long to wait before it."""
        self.attempt += 1
        # Bound the exponent so a long outage cannot overflow the float power.
        exponent = min(self.attempt, _MAX_BACKOFF_EXPONENT)
        backoff_seconds = min(self._base**exponent, self._max_delay_seconds)
        return backoff_seconds * (1.0 - self._jitter_ratio * self._random_fraction())
