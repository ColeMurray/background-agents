"""Retiring a connection whose write stalled (issue #1945).

A peer that stops reading leaves the socket OPEN and every write parked in
flow control. The keepalive ping parks behind the same flow control before
its pong deadline is armed, so the connection never fails on its own, and the
owner's receive loop — the only thing that triggers a reconnect — never ends.
The forwarder therefore ends such a connection itself.
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from tests.event_forwarder_fakes import (
    hung_ws,
    make_forwarder,
    open_ws,
    sent_events,
    settle,
    wedged_ws,
)


class TestDirectSendRetirement:
    @pytest.mark.asyncio
    async def test_timed_out_send_retires_the_connection(self):
        forwarder = make_forwarder(send_timeout_seconds=0.01)
        ws = hung_ws()
        await forwarder.bind(ws)

        assert await forwarder.send({"type": "token", "messageId": "msg-1"}) is False

        assert forwarder._ws is None
        ws.transport.abort.assert_called_once()
        assert [event["messageId"] for event in forwarder._event_buffer] == ["msg-1"]

    @pytest.mark.asyncio
    async def test_retirement_aborts_rather_than_closing(self):
        """``close()`` writes its close frame through the very flow control
        that just stalled, and websockets' ``close_timeout`` does not cover
        that wait — so a graceful close would park exactly like the write.
        Retirement must cost no part of the window left to reconnect in."""
        forwarder = make_forwarder(send_timeout_seconds=0.1)
        ws = hung_ws()
        await forwarder.bind(ws)

        started = asyncio.get_running_loop().time()
        assert await forwarder.send({"type": "execution_complete", "messageId": "msg-2"}) is False
        elapsed = asyncio.get_running_loop().time() - started

        ws.close.assert_not_awaited()
        ws.transport.abort.assert_called_once()
        # The write budget and nothing more.
        assert elapsed < 0.15

    @pytest.mark.asyncio
    async def test_retired_connection_stops_costing_a_budget_per_send(self):
        """Without retirement every later send re-enters the same dead socket
        and burns the whole budget again, so heartbeats stop being sent long
        before the control plane's staleness deadline."""
        forwarder = make_forwarder(send_timeout_seconds=0.1)
        await forwarder.bind(hung_ws())
        await forwarder.send({"type": "heartbeat"})

        started = asyncio.get_running_loop().time()
        assert await forwarder.send({"type": "token", "messageId": "msg-3"}) is False
        assert asyncio.get_running_loop().time() - started < 0.05

        assert [event.get("messageId") for event in forwarder._event_buffer] == [None, "msg-3"]

    @pytest.mark.asyncio
    async def test_unbuffered_timeout_retires_without_replaying(self):
        """The event is dropped, but the wedge it discovered is still real:
        a boot phase may be the only send that ever hits it."""
        forwarder = make_forwarder(send_timeout_seconds=0.01)
        ws = hung_ws()
        await forwarder.bind(ws)

        delivered = await asyncio.wait_for(
            forwarder.send({"type": "boot_progress", "bootSeq": 7}, buffered=False), timeout=0.5
        )

        assert delivered is False
        assert forwarder._ws is None
        ws.transport.abort.assert_called_once()
        assert forwarder._event_buffer == []
        replacement = open_ws()
        await forwarder.bind(replacement)
        assert sent_events(replacement) == []

    @pytest.mark.asyncio
    async def test_ordinary_send_failure_does_not_retire(self):
        """A connection that reports its own failure is already closing, and
        the owner's receive loop will see it. Only the silent wedge needs
        the forwarder to intervene."""
        forwarder = make_forwarder()
        ws = open_ws()
        ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        await forwarder.bind(ws)

        assert await forwarder.send({"type": "execution_complete", "messageId": "msg-4"}) is False

        assert forwarder._ws is ws
        ws.transport.abort.assert_not_called()

    @pytest.mark.asyncio
    async def test_cancelled_send_does_not_retire(self):
        """Cancellation is not evidence of a wedge — a prompt stopped by the
        user cancels sends on a perfectly healthy connection, and retiring
        there would tear down a connection that works. The event is still
        re-buffered, and a genuinely wedged connection is retired by the next
        write that times out on it."""
        forwarder = make_forwarder()
        ws = hung_ws()
        await forwarder.bind(ws)
        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-5"})
        )
        await settle()

        send_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await send_task

        assert forwarder._ws is ws
        ws.transport.abort.assert_not_called()
        assert [event["messageId"] for event in forwarder._event_buffer] == ["msg-5"]


class TestRecoveryRetirement:
    """Recovery is often the first write to a fresh connection, so it can be
    the first to find one already wedged. The owner awaits ``bind`` before its
    receive loop starts, so leaving the socket bound here costs another whole
    send before anything notices."""

    @pytest.mark.asyncio
    async def test_recovery_flush_timeout_retires_the_connection(self):
        forwarder = make_forwarder(send_timeout_seconds=0.01)
        await forwarder.send({"type": "execution_complete", "messageId": "msg-6"})
        ws = hung_ws()

        await forwarder.bind(ws)

        assert forwarder._ws is None
        ws.transport.abort.assert_called_once()
        assert [event["messageId"] for event in forwarder._event_buffer] == ["msg-6"]

        replacement = open_ws()
        await forwarder.bind(replacement)
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-6"
        ]

    @pytest.mark.asyncio
    async def test_pending_ack_resend_timeout_retires_the_connection(self):
        """Same for the pending-ACK stage, which runs on an empty buffer."""
        forwarder = make_forwarder(send_timeout_seconds=0.01)
        first = open_ws()
        await forwarder.bind(first)
        assert await forwarder.send({"type": "execution_complete", "messageId": "msg-7"}) is True
        forwarder.unbind()
        assert forwarder._event_buffer == []

        ws = hung_ws()
        await forwarder.bind(ws)

        assert forwarder._ws is None
        ws.transport.abort.assert_called_once()

        replacement = open_ws()
        await forwarder.bind(replacement)
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-7"
        ]
        assert forwarder.acknowledge("execution_complete:msg-7") is True


class TestReplacementSafety:
    """Retirement must hit the connection that stalled and nothing else."""

    @pytest.mark.asyncio
    async def test_replacement_bound_during_the_stalled_send_survives_and_drains(self):
        forwarder = make_forwarder(send_timeout_seconds=0.05)
        old = hung_ws()
        await forwarder.bind(old)
        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-8"})
        )
        await settle()

        replacement = open_ws()
        await forwarder.bind(replacement)

        assert await asyncio.wait_for(send_task, timeout=0.5) is False

        old.transport.abort.assert_called_once()
        assert forwarder._ws is replacement
        replacement.transport.abort.assert_not_called()
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-8"
        ]
        assert forwarder._event_buffer == []
        assert forwarder.acknowledge("execution_complete:msg-8") is True

    @pytest.mark.asyncio
    async def test_drain_deadline_retires_the_replacement_it_stalled_on(self):
        """The drain stage arms its deadline before the flush write arms its
        own, so the stage is what cancels a stalled replacement write — and a
        cancelled write cannot retire its own connection."""
        forwarder = make_forwarder(send_timeout_seconds=0.05)
        release_failure = asyncio.Event()
        old = wedged_ws(release_failure)
        await forwarder.bind(old)
        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-9"})
        )
        await settle()

        forwarder.unbind()
        replacement = hung_ws()
        await forwarder.bind(replacement)
        release_failure.set()

        assert await asyncio.wait_for(send_task, timeout=1) is False

        assert forwarder._ws is None
        replacement.transport.abort.assert_called_once()
        assert [event["messageId"] for event in forwarder._event_buffer] == ["msg-9"]

    @pytest.mark.asyncio
    async def test_drain_deadline_on_the_lock_keeps_the_replacement_bound(self):
        """A stage that expired waiting for the lock never wrote anything, so
        it has no evidence the replacement is wedged — retiring it there
        would kill a healthy connection."""
        forwarder = make_forwarder(send_timeout_seconds=0.05)
        release_failure = asyncio.Event()
        old = wedged_ws(release_failure)
        await forwarder.bind(old)
        send_task = asyncio.create_task(
            forwarder.send({"type": "execution_complete", "messageId": "msg-10"})
        )
        await settle()

        await forwarder._recovery_lock.acquire()
        replacement = open_ws()
        bind_task = asyncio.create_task(forwarder.bind(replacement))
        await settle()  # bind publishes the replacement, then waits for the lock
        release_failure.set()

        try:
            assert await asyncio.wait_for(send_task, timeout=1) is False
            assert forwarder._ws is replacement
            replacement.transport.abort.assert_not_called()
        finally:
            forwarder._recovery_lock.release()

        await bind_task
        assert [event["ackId"] for event in sent_events(replacement)] == [
            "execution_complete:msg-10"
        ]
