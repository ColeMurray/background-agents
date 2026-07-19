"""Buffered, ack-aware event forwarding from the sandbox to the control plane."""

from __future__ import annotations

import json
import secrets
import time
from typing import TYPE_CHECKING, Any, Final

from websockets import State

if TYPE_CHECKING:
    from websockets import ClientConnection

    from .log_config import StructuredLogger

# Critical events are retained until the control plane acknowledges them and
# are re-sent on reconnect; everything else is delivered at most once.
CRITICAL_EVENT_TYPES: Final[frozenset[str]] = frozenset(
    {
        "execution_complete",
        "error",
        "snapshot_ready",
        "push_complete",
        "push_error",
    }
)
MAX_EVENT_BUFFER_SIZE: Final = 1000


class BufferedEventForwarder:
    """Forwards sandbox events over the currently bound WebSocket.

    Owns the reconnect-safe delivery state machine:

    - While no connection is bound (or a send fails), events land in a
      bounded buffer that evicts non-critical events first.
    - Critical events carry an ``ackId`` and stay pending until the control
      plane acknowledges them, so they can be re-sent on a new connection.
    - ``bind`` is the single reconnect operation: it attaches the connection
      and recovers the backlog (buffered events, then unacknowledged
      criticals) without sending anything twice.

    The owner drives the connection lifecycle explicitly via ``bind`` /
    ``unbind``; the forwarder never reaches back into its owner.
    """

    def __init__(
        self,
        *,
        sandbox_id: str,
        log: StructuredLogger,
        max_buffer_size: int = MAX_EVENT_BUFFER_SIZE,
    ) -> None:
        self._sandbox_id = sandbox_id
        self._log = log
        self._max_buffer_size = max_buffer_size
        self._ws: ClientConnection | None = None

        # Event buffer: survives WS reconnection, flushed on reconnect.
        self._event_buffer: list[dict[str, Any]] = []

        # Pending ACKs: events sent but not yet acknowledged by the control
        # plane. Keyed by ackId, re-sent on reconnect until the DO confirms
        # receipt.
        self._pending_acks: dict[str, dict[str, Any]] = {}

    async def bind(self, ws: ClientConnection) -> None:
        """Attach a live control-plane connection and recover the backlog.

        Recovery order: snapshot the ackIds that were already pending, flush
        the event buffer (which starts tracking any criticals it sends), then
        re-send only the snapshotted entries that are still pending. The
        snapshot is what keeps a critical event flushed from the buffer from
        being sent a second time on the same reconnect.
        """
        self._ws = ws
        pending_before_flush = list(self._pending_acks)
        await self._flush_buffer()
        await self._resend_pending(pending_before_flush)

    def unbind(self) -> None:
        """Detach the connection; subsequent sends buffer until the next bind."""
        self._ws = None

    async def send(self, event: dict[str, Any]) -> None:
        """Send event to control plane, buffering if WS is unavailable."""
        event_type = event.get("type", "unknown")
        event["sandboxId"] = self._sandbox_id
        event["timestamp"] = event.get("timestamp", time.time())

        is_critical = event_type in CRITICAL_EVENT_TYPES
        if is_critical and "ackId" not in event:
            event["ackId"] = self._make_ack_id(event)

        ws = self._ws
        if not ws or ws.state != State.OPEN:
            self._buffer_event(event)
            return

        try:
            await ws.send(json.dumps(event))
            if is_critical:
                self._pending_acks[event["ackId"]] = event
        except Exception as e:
            self._log.warn("bridge.send_error", event_type=event_type, exc=e)
            self._buffer_event(event)
            await self._drain_if_rebound(failed_ws=ws)

    def acknowledge(self, ack_id: str) -> bool:
        """Drop a pending critical event the control plane confirmed.

        Returns True when the ackId was known (and is now cleared).
        """
        if ack_id in self._pending_acks:
            del self._pending_acks[ack_id]
            return True
        return False

    async def _drain_if_rebound(self, *, failed_ws: ClientConnection) -> None:
        """Deliver events stranded by a send that outlived its connection.

        A wedged send can fail only minutes later, after a replacement
        connection was already bound and its recovery flush ran; the failed
        event would then sit buffered until a reconnect that may never come.
        If a different open connection is bound by the time the failure
        surfaces, drain the buffer through it immediately. A drain failure
        just leaves events buffered — no retries.
        """
        current = self._ws
        if current is not None and current is not failed_ws and current.state == State.OPEN:
            await self._flush_buffer()

    async def _flush_buffer(self) -> None:
        """Flush buffered events over the currently bound connection."""
        if not self._event_buffer:
            return

        self._log.info("bridge.flush_buffer_start", buffer_size=len(self._event_buffer))
        flushed = 0
        while self._event_buffer:
            event = self._event_buffer[0]
            ws = self._ws
            if not ws or ws.state != State.OPEN:
                break
            try:
                await ws.send(json.dumps(event))
                self._event_buffer.pop(0)
                flushed += 1
                # Track critical events sent from buffer as pending ACKs
                if event.get("type") in CRITICAL_EVENT_TYPES and "ackId" in event:
                    self._pending_acks[event["ackId"]] = event
            except Exception as e:
                self._log.warn("bridge.flush_send_error", exc=e)
                break

        self._log.info(
            "bridge.flush_buffer_complete",
            flushed=flushed,
            remaining=len(self._event_buffer),
        )

    async def _resend_pending(self, ack_ids: list[str]) -> None:
        """Re-send unacknowledged critical events on a new WS connection.

        Only the given ackIds are considered (the ones pending before the
        buffer flush), and only if they are still pending. Events stay
        pending until the DO sends an ACK command.
        """
        to_resend = [ack_id for ack_id in ack_ids if ack_id in self._pending_acks]
        if not to_resend:
            return

        self._log.info("bridge.flush_pending_acks_start", count=len(to_resend))
        resent = 0
        for ack_id in to_resend:
            event = self._pending_acks.get(ack_id)
            if event is None:
                continue
            ws = self._ws
            if not ws or ws.state != State.OPEN:
                break
            try:
                await ws.send(json.dumps(event))
                resent += 1
            except Exception as e:
                self._log.warn("bridge.flush_pending_ack_error", ack_id=ack_id, exc=e)
                break

        self._log.info(
            "bridge.flush_pending_acks_complete",
            resent=resent,
            total=len(self._pending_acks),
        )

    def _buffer_event(self, event: dict[str, Any]) -> None:
        """Buffer an event for later delivery after WS reconnect."""
        if len(self._event_buffer) >= self._max_buffer_size:
            # Evict oldest non-critical event; fall back to oldest if all critical
            evicted = False
            for i, buffered in enumerate(self._event_buffer):
                if buffered.get("type") not in CRITICAL_EVENT_TYPES:
                    self._event_buffer.pop(i)
                    evicted = True
                    break
            if not evicted:
                self._event_buffer.pop(0)

        self._event_buffer.append(event)
        self._log.debug(
            "bridge.event_buffered",
            event_type=event.get("type", "unknown"),
            buffer_size=len(self._event_buffer),
        )

    @staticmethod
    def _make_ack_id(event: dict[str, Any]) -> str:
        """Generate a deterministic ack ID for a critical event.

        Format: "{type}:{messageId}" for events with messageId,
        "{type}:{random_hex}" for events without (e.g., snapshot_ready).
        Deterministic IDs give natural deduplication on the DO side.
        """
        event_type = event.get("type", "unknown")
        message_id = event.get("messageId")
        if message_id:
            return f"{event_type}:{message_id}"
        return f"{event_type}:{secrets.token_hex(8)}"
