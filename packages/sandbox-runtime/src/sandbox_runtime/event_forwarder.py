"""Buffered, ack-aware event forwarding from the sandbox to the control plane."""

from __future__ import annotations

import asyncio
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
        "preservation_prepared",
        "sandbox_generation_ready",
    }
)
MAX_EVENT_BUFFER_SIZE: Final = 1000

# Bound on a direct send and on each recovery stage. A failed direct send may
# spend one additional budget acquiring the recovery lock and flushing after
# a rebind, so send() takes at most two configured budgets before returning.
SEND_TIMEOUT_SECONDS: Final = 30.0


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
    - All recovery flushing is serialized by one lock, so a stale-send drain
      and a concurrent bind can never both walk the buffer.

    The owner drives the connection lifecycle explicitly via ``bind`` /
    ``unbind``; the forwarder never reaches back into its owner.
    """

    def __init__(
        self,
        *,
        sandbox_id: str,
        log: StructuredLogger,
        max_buffer_size: int = MAX_EVENT_BUFFER_SIZE,
        send_timeout_seconds: float = SEND_TIMEOUT_SECONDS,
    ) -> None:
        self._sandbox_id = sandbox_id
        self._log = log
        self._max_buffer_size = max_buffer_size
        self._send_timeout_seconds = send_timeout_seconds
        self._ws: ClientConnection | None = None

        # Serializes every buffer walk (bind recovery and stale-send drains).
        # Concurrent flush loops would each claim the buffer head and pop
        # events the other one sent — or never sent.
        self._recovery_lock = asyncio.Lock()

        # Event buffer: survives WS reconnection, flushed on reconnect.
        self._event_buffer: list[dict[str, Any]] = []

        # Pending ACKs: in-flight or sent events not yet acknowledged by the
        # control plane. Keyed by ackId, re-sent on reconnect after the owning
        # in-flight attempt settles and until the DO confirms receipt.
        self._pending_acks: dict[str, dict[str, Any]] = {}
        # ACK-visible attempts that have not returned from ws.send yet. Bind
        # excludes them from pending replay; their owning send reconciles the
        # ACK and any failure before deciding whether one buffered copy remains.
        self._in_flight_acks: dict[str, dict[str, Any]] = {}

    async def bind(self, ws: ClientConnection) -> None:
        """Attach a live control-plane connection and recover the backlog.

        Pending ackIds are captured before publishing the connection, so a
        drain already holding the lock cannot first send a buffered critical
        through this connection and then have this bind replay it. Publishing
        before acquiring the lock still lets that drain migrate to the new
        connection.

        Under the lock, flush the event buffer and then re-send only pre-bind
        candidates that are still pending.
        """
        pending_before_bind = [
            ack_id for ack_id in self._pending_acks if ack_id not in self._in_flight_acks
        ]
        self._ws = ws
        async with self._recovery_lock:
            await self._flush_buffer()
            await self._resend_pending(pending_before_bind)

    def unbind(self) -> None:
        """Detach the connection; subsequent sends buffer until the next bind."""
        self._ws = None

    async def send(self, event: dict[str, Any], *, buffered: bool = True) -> bool:
        """Send event to control plane, buffering if WS is unavailable.

        ``buffered=False`` sends only over an open connection and otherwise
        drops the event: for reports whose value is being current (a boot
        phase), a replay after reconnect would only be stale.

        Returns whether the event reached an open connection. A caller that
        keeps its own durable record of what it has delivered (the boot-event
        relay's cursor) must not advance it on a buffered event: the buffer
        lives only as long as this process.
        """
        event_type = event.get("type", "unknown")
        event["sandboxId"] = self._sandbox_id
        event["timestamp"] = event.get("timestamp", time.time())

        is_critical = event_type in CRITICAL_EVENT_TYPES
        if is_critical and "ackId" not in event:
            event["ackId"] = self._make_ack_id(event)

        ws = self._ws
        if not ws or ws.state != State.OPEN:
            if buffered:
                self._buffer_event(event)
            else:
                self._log.debug("bridge.event_dropped_unbound", event_type=event_type)
            return False

        ack_id = event["ackId"] if is_critical else None
        if ack_id is not None:
            self._pending_acks[ack_id] = event
            self._in_flight_acks[ack_id] = event
        try:
            await asyncio.wait_for(ws.send(json.dumps(event)), timeout=self._send_timeout_seconds)
        except asyncio.CancelledError:
            # A prompt task cancelled mid-send must not strand its event:
            # re-buffer it, then let the cancellation proceed. An unbuffered
            # event is dropped here too — a replay would only be stale.
            replayable = ack_id is None or self._pending_acks.get(ack_id) is event
            if ack_id is not None and replayable:
                self._pending_acks.pop(ack_id, None)
            if buffered and replayable:
                self._buffer_event(event)
            else:
                self._log.debug("bridge.event_dropped_cancelled", event_type=event_type)
            raise
        except Exception as e:
            self._log.warn("bridge.send_error", event_type=event_type, exc=e)
            replayable = ack_id is None or self._pending_acks.get(ack_id) is event
            if ack_id is not None and replayable:
                self._pending_acks.pop(ack_id, None)
            if not buffered or not replayable:
                self._log.debug("bridge.event_dropped_send_failed", event_type=event_type)
                return False
            self._buffer_event(event)
            await self._drain_if_rebound(failed_ws=ws)
            return False
        finally:
            if ack_id is not None and self._in_flight_acks.get(ack_id) is event:
                self._in_flight_acks.pop(ack_id, None)
        return True

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

        The event was buffered before this await, and an active recovery
        cannot pass its final empty-check and release the lock without that
        event being visible — so waiting on the lock (rather than skipping
        when busy) lets this recovery flush the event exactly once when it
        completes within budget. On timeout, the event remains buffered for
        a later bind.
        """
        current = self._ws
        if current is not None and current is not failed_ws and current.state == State.OPEN:
            try:
                async with asyncio.timeout(self._send_timeout_seconds):
                    async with self._recovery_lock:
                        await self._flush_buffer()
            except TimeoutError as e:
                # send() already buffered the event before recovery. Leave
                # that single copy for a later bind rather than buffering it
                # again when lock acquisition or flushing exhausts the stage.
                self._log.warn("bridge.rebound_recovery_timeout", exc=e)

    async def _flush_buffer(self) -> None:
        """Flush buffered events over the currently bound connection.

        Must run under ``_recovery_lock``. The connection is re-read every
        iteration so a rebind while flushing migrates the walk onto the new
        connection.

        Known debt: an event ``json.dumps`` cannot serialize would be a
        poison pill at the buffer head — every flush breaks on it.
        """
        if not self._event_buffer:
            return

        self._log.info("bridge.flush_buffer_start", buffer_size=len(self._event_buffer))
        flushed = 0
        while self._event_buffer:
            event = self._event_buffer[0]
            ws = self._ws
            if not ws or ws.state != State.OPEN:
                break
            is_critical = event.get("type") in CRITICAL_EVENT_TYPES and "ackId" in event
            ack_id = event["ackId"] if is_critical else None
            if ack_id is not None:
                self._pending_acks[ack_id] = event
                self._in_flight_acks[ack_id] = event
            try:
                await asyncio.wait_for(
                    ws.send(json.dumps(event)), timeout=self._send_timeout_seconds
                )
            except asyncio.CancelledError:
                acknowledged = ack_id is not None and self._pending_acks.get(ack_id) is not event
                if ack_id is not None and not acknowledged:
                    self._pending_acks.pop(ack_id, None)
                if acknowledged and self._event_buffer and self._event_buffer[0] is event:
                    self._event_buffer.pop(0)
                raise
            except Exception as e:
                acknowledged = ack_id is not None and self._pending_acks.get(ack_id) is not event
                if ack_id is not None and not acknowledged:
                    self._pending_acks.pop(ack_id, None)
                if acknowledged and self._event_buffer and self._event_buffer[0] is event:
                    self._event_buffer.pop(0)
                self._log.warn("bridge.flush_send_error", exc=e)
                break
            finally:
                if ack_id is not None and self._in_flight_acks.get(ack_id) is event:
                    self._in_flight_acks.pop(ack_id, None)

            # The send succeeded, but a concurrent overflow eviction may have
            # removed our claimed head while the send was in flight — pop by
            # identity so we never pop an event nobody sent.
            if self._event_buffer and self._event_buffer[0] is event:
                self._event_buffer.pop(0)
            flushed += 1

        self._log.info(
            "bridge.flush_buffer_complete",
            flushed=flushed,
            remaining=len(self._event_buffer),
        )

    async def _resend_pending(self, ack_ids: list[str]) -> None:
        """Re-send unacknowledged critical events on a new WS connection.

        Must run under ``_recovery_lock``. Only the given ackIds are
        considered (the ones pending before the buffer flush), and only if
        they are still pending. Events stay pending until the DO sends an
        ACK command.
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
                await asyncio.wait_for(
                    ws.send(json.dumps(event)), timeout=self._send_timeout_seconds
                )
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

        Known debt: two distinct events reusing a messageId share an ackId,
        so the later one overwrites the earlier pending entry.
        """
        event_type = event.get("type", "unknown")
        operation_id = event.get("operationId")
        if operation_id:
            return f"{event_type}:{operation_id}"
        generation = event.get("generation")
        if event_type == "sandbox_generation_ready" and isinstance(generation, dict):
            return f"{event_type}:{generation.get('sandboxId')}:{generation.get('createdAt')}"
        message_id = event.get("messageId")
        if message_id:
            return f"{event_type}:{message_id}"
        return f"{event_type}:{secrets.token_hex(8)}"
