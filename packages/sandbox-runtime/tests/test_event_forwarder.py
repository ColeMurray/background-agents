"""
Unit tests for BufferedEventForwarder.

Covers the reconnect-safe delivery state machine through its public surface:
buffering while no connection is bound, bind-time backlog recovery (without
double-sends), the ACK lifecycle, stale-send recovery after a rebind, and
bounded-buffer overflow eviction.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.event_forwarder import SEND_TIMEOUT_SECONDS, BufferedEventForwarder


def make_forwarder(
    max_buffer_size: int = 1000,
    send_timeout_seconds: float = SEND_TIMEOUT_SECONDS,
) -> BufferedEventForwarder:
    return BufferedEventForwarder(
        sandbox_id="test-sandbox",
        log=MagicMock(),
        max_buffer_size=max_buffer_size,
        send_timeout_seconds=send_timeout_seconds,
    )


def open_ws() -> MagicMock:
    ws = MagicMock()
    ws.state = State.OPEN
    ws.send = AsyncMock()
    return ws


def sent_events(ws: MagicMock) -> list[dict]:
    return [json.loads(call.args[0]) for call in ws.send.await_args_list]


def wedged_ws(fail_signal: asyncio.Event) -> MagicMock:
    """A connection whose sends hang until signalled, then fail."""
    ws = MagicMock()
    ws.state = State.OPEN

    async def wedged_send(data: str) -> None:
        await fail_signal.wait()
        raise ConnectionError("stale connection flap")

    ws.send = wedged_send
    return ws


class GatedWs:
    """Fake connection: every send records its payload, then suspends until
    the test releases that send by index (with success or an exception)."""

    def __init__(self):
        self.state = State.OPEN
        self.calls: list[dict] = []  # decoded payloads, in send order

        self._results: list[asyncio.Future] = []

    async def send(self, data: str) -> None:
        future = asyncio.get_running_loop().create_future()
        self.calls.append(json.loads(data))
        self._results.append(future)
        await future

    def release(self, index: int, exc: Exception | None = None) -> None:
        if exc is None:
            self._results[index].set_result(None)
        else:
            self._results[index].set_exception(exc)

    def message_ids(self) -> list[str | None]:
        return [call.get("messageId") for call in self.calls]


async def settle() -> None:
    """Let every runnable coroutine advance to its next suspension point."""
    for _ in range(5):
        await asyncio.sleep(0)


class TestBufferWhileDisconnected:
    @pytest.mark.asyncio
    async def test_send_buffers_when_never_bound(self):
        forwarder = make_forwarder()

        await forwarder.send({"type": "token", "content": "hello"})

        assert len(forwarder._event_buffer) == 1
        buffered = forwarder._event_buffer[0]
        assert buffered["type"] == "token"
        # Sandbox identity and timestamp are stamped even while buffering
        assert buffered["sandboxId"] == "test-sandbox"
        assert "timestamp" in buffered

    @pytest.mark.asyncio
    async def test_send_buffers_after_unbind(self):
        forwarder = make_forwarder()
        await forwarder.bind(open_ws())
        forwarder.unbind()

        await forwarder.send({"type": "token", "content": "hello"})

        assert len(forwarder._event_buffer) == 1

    @pytest.mark.asyncio
    async def test_send_buffers_when_bound_ws_not_open(self):
        forwarder = make_forwarder()
        ws = open_ws()
        ws.state = State.CLOSED
        await forwarder.bind(ws)

        await forwarder.send({"type": "token", "content": "hello"})

        ws.send.assert_not_awaited()
        assert len(forwarder._event_buffer) == 1

    @pytest.mark.asyncio
    async def test_send_failure_buffers_and_does_not_track_pending(self):
        forwarder = make_forwarder()
        ws = open_ws()
        ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        await forwarder.bind(ws)

        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        assert len(forwarder._event_buffer) == 1
        assert len(forwarder._pending_acks) == 0


class TestSendWhileConnected:
    @pytest.mark.asyncio
    async def test_critical_event_gets_ack_id_and_pends(self):
        forwarder = make_forwarder()
        ws = open_ws()
        await forwarder.bind(ws)

        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        [event] = sent_events(ws)
        assert event["ackId"] == "execution_complete:msg-1"
        assert forwarder._pending_acks["execution_complete:msg-1"]["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_non_critical_event_has_no_ack_id(self):
        forwarder = make_forwarder()
        ws = open_ws()
        await forwarder.bind(ws)

        await forwarder.send({"type": "token", "content": "hello"})

        [event] = sent_events(ws)
        assert "ackId" not in event
        assert len(forwarder._pending_acks) == 0

    @pytest.mark.asyncio
    async def test_ack_id_is_random_and_unique_without_message_id(self):
        forwarder = make_forwarder()
        ws = open_ws()
        await forwarder.bind(ws)

        await forwarder.send({"type": "snapshot_ready"})
        await forwarder.send({"type": "snapshot_ready"})

        ack_ids = [event["ackId"] for event in sent_events(ws)]
        for ack_id in ack_ids:
            prefix, suffix = ack_id.split(":", 1)
            assert prefix == "snapshot_ready"
            assert len(suffix) == 16
            int(suffix, 16)  # Should not raise
        assert len(set(ack_ids)) == 2

    @pytest.mark.asyncio
    async def test_existing_ack_id_not_overwritten(self):
        forwarder = make_forwarder()
        ws = open_ws()
        await forwarder.bind(ws)

        await forwarder.send(
            {"type": "execution_complete", "messageId": "msg-1", "ackId": "custom:id"}
        )

        [event] = sent_events(ws)
        assert event["ackId"] == "custom:id"
        assert forwarder.acknowledge("custom:id") is True

    @pytest.mark.asyncio
    async def test_acknowledge_clears_pending(self):
        forwarder = make_forwarder()
        await forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        assert forwarder.acknowledge("execution_complete:msg-1") is True
        assert len(forwarder._pending_acks) == 0
        # Unknown ackIds report not-found
        assert forwarder.acknowledge("execution_complete:msg-1") is False


class TestBindRecovery:
    @pytest.mark.asyncio
    async def test_bind_flushes_buffered_events_in_order(self):
        forwarder = make_forwarder()
        await forwarder.send({"type": "token", "content": "a"})
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        ws = open_ws()
        await forwarder.bind(ws)

        assert len(forwarder._event_buffer) == 0
        assert [event["type"] for event in sent_events(ws)] == ["token", "execution_complete"]
        # The critical event starts pending on flush, awaiting its ACK
        assert forwarder.acknowledge("execution_complete:msg-1") is True

    @pytest.mark.asyncio
    async def test_bind_with_no_backlog_sends_nothing(self):
        forwarder = make_forwarder()

        ws = open_ws()
        await forwarder.bind(ws)

        ws.send.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_bind_flush_stops_on_send_failure_and_keeps_remainder(self):
        forwarder = make_forwarder()
        await forwarder.send({"type": "token", "content": "a"})
        await forwarder.send({"type": "token", "content": "b"})

        ws = open_ws()
        ws.send = AsyncMock(side_effect=[None, ConnectionError("broken")])
        await forwarder.bind(ws)

        assert len(forwarder._event_buffer) == 1
        assert forwarder._event_buffer[0]["content"] == "b"

    @pytest.mark.asyncio
    async def test_bind_does_not_double_send_buffered_criticals(self):
        """A critical event flushed from the buffer must not also be re-sent
        by the pending-ack recovery on the same bind."""
        forwarder = make_forwarder()
        # msg-1 was sent on a previous connection and never acknowledged
        await forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        forwarder.unbind()
        # msg-2 completed while disconnected, so it sits in the buffer
        await forwarder.send({"type": "execution_complete", "messageId": "msg-2"})

        ws = open_ws()
        await forwarder.bind(ws)

        # msg-2 once from the buffer, msg-1 once from pending acks — no dupes
        assert [event["ackId"] for event in sent_events(ws)] == [
            "execution_complete:msg-2",
            "execution_complete:msg-1",
        ]
        assert set(forwarder._pending_acks) == {
            "execution_complete:msg-1",
            "execution_complete:msg-2",
        }

    @pytest.mark.asyncio
    async def test_bind_resends_all_unacknowledged_criticals(self):
        forwarder = make_forwarder()
        await forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        await forwarder.send({"type": "error", "messageId": "msg-2"})
        forwarder.unbind()

        ws = open_ws()
        await forwarder.bind(ws)

        assert ws.send.await_count == 2
        # Both stay pending until an ACK command clears them
        assert forwarder.acknowledge("execution_complete:msg-1") is True
        assert forwarder.acknowledge("error:msg-2") is True

    @pytest.mark.asyncio
    async def test_bind_does_not_resend_acknowledged_events(self):
        forwarder = make_forwarder()
        await forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        assert forwarder.acknowledge("execution_complete:msg-1") is True
        forwarder.unbind()

        ws = open_ws()
        await forwarder.bind(ws)

        ws.send.assert_not_awaited()


class TestStaleSendRecovery:
    @pytest.mark.asyncio
    async def test_send_failure_after_rebind_drains_through_new_connection(self):
        """A wedged send can fail only after the watchdog already bound and
        flushed a replacement connection; the event must be delivered on the
        new connection instead of sitting stranded in the buffer."""
        forwarder = make_forwarder()

        release_failure = asyncio.Event()
        old_ws = MagicMock()
        old_ws.state = State.OPEN

        async def wedged_send(data):
            await release_failure.wait()
            raise ConnectionError("connection timed out")

        old_ws.send = wedged_send
        await forwarder.bind(old_ws)

        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        )
        await asyncio.sleep(0)  # the send is now in flight on old_ws

        # Watchdog reconnects: replacement bound, recovery already ran (empty)
        forwarder.unbind()
        new_ws = open_ws()
        await forwarder.bind(new_ws)
        assert sent_events(new_ws) == []

        # The wedged send finally fails, long after the rebind
        release_failure.set()
        await send_task

        assert [event["ackId"] for event in sent_events(new_ws)] == ["execution_complete:msg-1"]
        assert forwarder._event_buffer == []
        # Delivered via the buffer drain, so it is tracked for ACK
        assert forwarder.acknowledge("execution_complete:msg-1") is True

    @pytest.mark.asyncio
    async def test_send_failure_without_rebind_stays_buffered(self):
        """When the failed connection is still the bound one there is nothing
        to drain through — the event stays buffered, with no retry loop."""
        forwarder = make_forwarder()
        ws = open_ws()
        ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        await forwarder.bind(ws)

        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        assert ws.send.await_count == 1
        assert len(forwarder._event_buffer) == 1


class TestConcurrentRecovery:
    """Races between bind() recovery, stale-send drains, sends, and eviction."""

    @pytest.mark.asyncio
    async def test_drain_waits_for_bind_flush_no_loss_or_duplicates(self):
        """Bug A: a stale-send drain must not walk the buffer concurrently
        with bind()'s recovery flush. Unserialized, both loops claim the same
        head (double-send) and pop events the other loop sent — or never
        sent, permanently losing a critical when a send then flaps."""
        forwarder = make_forwarder()

        # W goes in flight on a connection that will only fail much later
        fail_old = asyncio.Event()
        old_ws = wedged_ws(fail_old)
        await forwarder.bind(old_ws)
        send_w = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-W"})
        )
        await settle()  # W is now suspended inside old_ws.send

        # Watchdog reconnects; X was buffered during the disconnected window
        forwarder.unbind()
        await forwarder.send({"type": "execution_complete", "messageId": "msg-X"})

        new_ws = GatedWs()
        bind_task = asyncio.create_task(forwarder.bind(new_ws))
        await settle()
        assert new_ws.message_ids() == ["msg-X"]  # bind flush suspended on X

        # The stale W send fails now; its drain must WAIT on the lock instead
        # of claiming the in-flight head X a second time
        fail_old.set()
        await settle()
        assert new_ws.message_ids() == ["msg-X"]

        # X completes; bind's flush moves on to W and hits a second flap
        new_ws.release(0)
        await settle()
        assert new_ws.message_ids() == ["msg-X", "msg-W"]
        new_ws.release(1, ConnectionError("second connection flap"))
        await settle()
        await bind_task
        # The drain now holds the lock and retries W on the live connection
        new_ws.release(2)
        await settle()
        await send_w

        # Each event hit the wire exactly once per delivery attempt sequence:
        # X once, W once failed + once delivered — nothing lost, nothing duped
        assert new_ws.message_ids() == ["msg-X", "msg-W", "msg-W"]
        assert forwarder._event_buffer == []
        assert forwarder.acknowledge("execution_complete:msg-X") is True
        assert forwarder.acknowledge("execution_complete:msg-W") is True

    @pytest.mark.asyncio
    async def test_event_buffered_as_flush_drains_to_empty_is_delivered(self):
        """Bug A (empty-window variant): an event buffered by a failing send
        while the recovery flush is on its last item must still be delivered
        exactly once, with its ACK tracked."""
        forwarder = make_forwarder()

        fail_old = asyncio.Event()
        old_ws = wedged_ws(fail_old)
        await forwarder.bind(old_ws)
        send_w = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-W"})
        )
        await settle()

        forwarder.unbind()
        await forwarder.send({"type": "token", "content": "x"})

        new_ws = GatedWs()
        bind_task = asyncio.create_task(forwarder.bind(new_ws))
        await settle()  # flush suspended sending the token (its only item)

        # W fails and is appended while the flush is mid-final-iteration
        fail_old.set()
        await settle()
        assert len(new_ws.calls) == 1  # the waiting drain claimed nothing

        new_ws.release(0)  # token delivered; the same walk picks up W next
        await settle()
        assert new_ws.message_ids() == [None, "msg-W"]
        new_ws.release(1)
        await settle()
        await bind_task
        await send_w

        assert new_ws.message_ids() == [None, "msg-W"]
        assert forwarder._event_buffer == []
        assert forwarder.acknowledge("execution_complete:msg-W") is True

    @pytest.mark.asyncio
    async def test_eviction_of_in_flight_head_does_not_pop_shifted_critical(self):
        """Bug B: while the flush is suspended sending the head, an overflow
        eviction can remove that head and shift a critical into position 0.
        A positional pop would discard the critical unsent."""
        forwarder = make_forwarder(max_buffer_size=2)
        await forwarder.send({"type": "token", "content": "x"})
        await forwarder.send({"type": "execution_complete", "messageId": "msg-Y"})
        # Buffer is at capacity: [token, Y]

        ws = GatedWs()
        bind_task = asyncio.create_task(forwarder.bind(ws))
        await settle()  # flush suspended sending the token head (call #0)

        # A direct send fails instantly; buffering it overflows the buffer,
        # evicting the in-flight token head and shifting Y to the front
        send_z = asyncio.create_task(
            forwarder.send({"type": "push_complete", "messageId": "msg-Z", "branchName": "b"})
        )
        await settle()
        ws.release(1, ConnectionError("broken"))  # the direct Z send fails
        await settle()
        await send_z
        assert [event["messageId"] for event in forwarder._event_buffer] == ["msg-Y", "msg-Z"]

        # The token send completes; the head is now Y, which the flush never
        # sent — it must stay put and be delivered next
        ws.release(0)
        await settle()
        assert ws.calls[2]["messageId"] == "msg-Y"
        ws.release(2)
        await settle()
        assert ws.calls[3]["messageId"] == "msg-Z"
        ws.release(3)
        await settle()
        await bind_task

        assert ws.message_ids().count("msg-Y") == 1
        assert forwarder._event_buffer == []
        assert forwarder.acknowledge("execution_complete:msg-Y") is True
        assert forwarder.acknowledge("push_complete:msg-Z") is True

    @pytest.mark.asyncio
    async def test_cancelled_send_rebuffers_event_and_propagates(self):
        """Bug C: cancelling a task suspended in send() must re-buffer the
        event before the cancellation propagates."""
        forwarder = make_forwarder()

        started = asyncio.Event()
        ws = MagicMock()
        ws.state = State.OPEN

        async def hanging_send(data: str) -> None:
            started.set()
            await asyncio.Event().wait()

        ws.send = hanging_send
        await forwarder.bind(ws)

        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        )
        await started.wait()
        send_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await send_task

        assert [event["type"] for event in forwarder._event_buffer] == ["execution_complete"]

        # The next bind delivers the re-buffered event
        replacement = open_ws()
        await forwarder.bind(replacement)
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-1"
        ]

    @pytest.mark.asyncio
    async def test_recovery_send_timeout_breaks_flush_and_keeps_event(self):
        """A wedged send inside recovery would hold the lock forever and turn
        into a wedged reconnect; it must time out, leave the event buffered,
        and let a later bind deliver it."""
        forwarder = make_forwarder(send_timeout_seconds=0.05)
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        hung_ws = MagicMock()
        hung_ws.state = State.OPEN

        async def never_completes(data: str) -> None:
            await asyncio.Event().wait()

        hung_ws.send = never_completes

        await forwarder.bind(hung_ws)  # returns: the timeout breaks the flush

        assert len(forwarder._event_buffer) == 1

        replacement = open_ws()
        await forwarder.bind(replacement)
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-1"
        ]


class TestOverflowEviction:
    @pytest.mark.asyncio
    async def test_overflow_evicts_oldest_non_critical_first(self):
        forwarder = make_forwarder(max_buffer_size=3)
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        await forwarder.send({"type": "token", "content": "a"})
        await forwarder.send({"type": "error", "messageId": "msg-2"})

        await forwarder.send({"type": "snapshot_ready"})

        types = [event["type"] for event in forwarder._event_buffer]
        assert types == ["execution_complete", "error", "snapshot_ready"]

    @pytest.mark.asyncio
    async def test_overflow_evicts_oldest_when_all_critical(self):
        forwarder = make_forwarder(max_buffer_size=2)
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        await forwarder.send({"type": "error", "messageId": "msg-2"})

        await forwarder.send({"type": "push_complete", "branchName": "b"})

        types = [event["type"] for event in forwarder._event_buffer]
        assert types == ["error", "push_complete"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
