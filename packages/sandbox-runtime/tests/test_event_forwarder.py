"""
Unit tests for BufferedEventForwarder.

Covers the reconnect-safe delivery state machine on its own: buffering while
no connection is bound, flushing on bind, the flush ack-skip contract, and
bounded-buffer overflow eviction.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.event_forwarder import BufferedEventForwarder


def make_forwarder(max_buffer_size: int = 1000) -> BufferedEventForwarder:
    return BufferedEventForwarder(
        sandbox_id="test-sandbox",
        log=MagicMock(),
        max_buffer_size=max_buffer_size,
    )


def open_ws() -> MagicMock:
    ws = MagicMock()
    ws.state = State.OPEN
    ws.send = AsyncMock()
    return ws


def sent_events(ws: MagicMock) -> list[dict]:
    return [json.loads(call.args[0]) for call in ws.send.await_args_list]


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
        forwarder.bind(open_ws())
        forwarder.unbind()

        await forwarder.send({"type": "token", "content": "hello"})

        assert len(forwarder._event_buffer) == 1

    @pytest.mark.asyncio
    async def test_send_buffers_when_bound_ws_not_open(self):
        forwarder = make_forwarder()
        ws = open_ws()
        ws.state = State.CLOSED
        forwarder.bind(ws)

        await forwarder.send({"type": "token", "content": "hello"})

        ws.send.assert_not_awaited()
        assert len(forwarder._event_buffer) == 1

    @pytest.mark.asyncio
    async def test_send_failure_buffers_and_does_not_track_pending(self):
        forwarder = make_forwarder()
        ws = open_ws()
        ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        forwarder.bind(ws)

        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        assert len(forwarder._event_buffer) == 1
        assert len(forwarder._pending_acks) == 0


class TestSendWhileConnected:
    @pytest.mark.asyncio
    async def test_critical_event_gets_ack_id_and_pends(self):
        forwarder = make_forwarder()
        ws = open_ws()
        forwarder.bind(ws)

        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        [event] = sent_events(ws)
        assert event["ackId"] == "execution_complete:msg-1"
        assert forwarder._pending_acks["execution_complete:msg-1"]["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_non_critical_event_has_no_ack_id(self):
        forwarder = make_forwarder()
        ws = open_ws()
        forwarder.bind(ws)

        await forwarder.send({"type": "token", "content": "hello"})

        [event] = sent_events(ws)
        assert "ackId" not in event
        assert len(forwarder._pending_acks) == 0

    @pytest.mark.asyncio
    async def test_acknowledge_clears_pending(self):
        forwarder = make_forwarder()
        forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        assert forwarder.acknowledge("execution_complete:msg-1") is True
        assert len(forwarder._pending_acks) == 0
        # Unknown ackIds report not-found
        assert forwarder.acknowledge("execution_complete:msg-1") is False


class TestFlushOnBind:
    @pytest.mark.asyncio
    async def test_flush_after_bind_sends_all_and_clears_buffer(self):
        forwarder = make_forwarder()
        await forwarder.send({"type": "token", "content": "a"})
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})

        ws = open_ws()
        forwarder.bind(ws)
        just_added = await forwarder.flush_event_buffer()

        assert len(forwarder._event_buffer) == 0
        assert [event["type"] for event in sent_events(ws)] == ["token", "execution_complete"]
        # The critical event starts pending on flush, and is reported as such
        assert just_added == {"execution_complete:msg-1"}
        assert "execution_complete:msg-1" in forwarder._pending_acks

    @pytest.mark.asyncio
    async def test_flush_without_bind_keeps_buffer(self):
        forwarder = make_forwarder()
        await forwarder.send({"type": "token", "content": "a"})

        just_added = await forwarder.flush_event_buffer()

        assert just_added == set()
        assert len(forwarder._event_buffer) == 1

    @pytest.mark.asyncio
    async def test_flush_stops_on_send_failure_and_keeps_remainder(self):
        forwarder = make_forwarder()
        await forwarder.send({"type": "token", "content": "a"})
        await forwarder.send({"type": "token", "content": "b"})

        ws = open_ws()
        ws.send = AsyncMock(side_effect=[None, ConnectionError("broken")])
        forwarder.bind(ws)

        await forwarder.flush_event_buffer()

        assert len(forwarder._event_buffer) == 1
        assert forwarder._event_buffer[0]["content"] == "b"


class TestAckSkipContract:
    """flush_event_buffer reports the ackIds it just started tracking, and
    flush_pending_acks must skip exactly those to avoid a double-send."""

    @pytest.mark.asyncio
    async def test_reconnect_flush_does_not_double_send_buffered_criticals(self):
        forwarder = make_forwarder()
        # msg-1 was sent on a previous connection and never acknowledged
        forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        forwarder.unbind()
        # msg-2 completed while disconnected, so it sits in the buffer
        await forwarder.send({"type": "execution_complete", "messageId": "msg-2"})

        ws = open_ws()
        forwarder.bind(ws)
        just_flushed = await forwarder.flush_event_buffer()
        await forwarder.flush_pending_acks(skip_ack_ids=just_flushed)

        events = sent_events(ws)
        # msg-2 once from the buffer, msg-1 once from pending acks — no dupes
        assert [event["ackId"] for event in events] == [
            "execution_complete:msg-2",
            "execution_complete:msg-1",
        ]
        assert set(forwarder._pending_acks) == {
            "execution_complete:msg-1",
            "execution_complete:msg-2",
        }

    @pytest.mark.asyncio
    async def test_flush_pending_acks_resends_everything_without_skip(self):
        forwarder = make_forwarder()
        forwarder.bind(open_ws())
        await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
        await forwarder.send({"type": "error", "messageId": "msg-2"})
        forwarder.unbind()

        ws = open_ws()
        forwarder.bind(ws)
        await forwarder.flush_pending_acks()

        assert ws.send.await_count == 2
        # Pending entries survive the resend; only an ACK command clears them
        assert len(forwarder._pending_acks) == 2


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
