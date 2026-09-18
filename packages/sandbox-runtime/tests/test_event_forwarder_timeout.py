"""Stalled live writes must retire only their own connection (issue #1945)."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.event_forwarder import BufferedEventForwarder


def connection():
    ws = MagicMock()
    ws.state = State.OPEN
    ws.send = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.mark.parametrize(
    "event_type,buffered",
    [
        ("token", True),
        ("execution_complete", True),
        ("boot_phase", False),
    ],
)
@pytest.mark.parametrize("rebind", ["after_timeout", "during_send", "during_close"])
async def test_stalled_write_recovers_without_retiring_replacement(event_type, buffered, rebind):
    old, replacement = connection(), connection()
    entered, close_entered, release_close = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def stalled_send(_payload):
        entered.set()
        await asyncio.Event().wait()

    async def close():
        close_entered.set()
        if rebind == "during_close":
            await release_close.wait()

    old.send = stalled_send
    old.close.side_effect = close
    forwarder = BufferedEventForwarder(
        sandbox_id="test",
        log=MagicMock(),
        send_timeout_seconds=0.05,
    )
    await forwarder.bind(old)
    event = {"type": event_type, "messageId": "message"}
    task = asyncio.create_task(forwarder.send(event, buffered=buffered))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        if rebind == "during_send":
            await forwarder.bind(replacement)
        elif rebind == "during_close":
            await asyncio.wait_for(close_entered.wait(), 2)
            assert forwarder._ws is None
            await forwarder.bind(replacement)
            release_close.set()
        assert await asyncio.wait_for(task, 2) is False
        old.close.assert_awaited_once()
        if rebind == "after_timeout":
            assert forwarder._ws is None
            await forwarder.bind(replacement)
        assert forwarder._ws is replacement
        replacement.close.assert_not_awaited()
        replacement.transport.abort.assert_not_called()
        assert replacement.send.await_count == int(buffered)
        assert forwarder._event_buffer == []
        if buffered:
            delivered = json.loads(replacement.send.await_args.args[0])
            assert delivered == event
            if event_type == "execution_complete":
                assert delivered["ackId"] == "execution_complete:message"
                assert forwarder.acknowledge(delivered["ackId"]) is True
                assert forwarder.acknowledge(delivered["ackId"]) is False
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("close_failure", ["timeout", "exception", "cancelled"])
@pytest.mark.parametrize("rebind", ["during_send", "during_close"])
async def test_close_cannot_strand_event_or_replacement(close_failure, rebind):
    old, replacement = connection(), connection()
    entered, close_entered = asyncio.Event(), asyncio.Event()

    async def stalled_send(_payload):
        entered.set()
        await asyncio.Event().wait()

    async def close():
        close_entered.set()
        if close_failure == "exception":
            raise OSError("broken close")
        await asyncio.Event().wait()

    old.send = stalled_send
    old.close.side_effect = close
    forwarder = BufferedEventForwarder(
        sandbox_id="test",
        log=MagicMock(),
        send_timeout_seconds=0.05,
    )
    await forwarder.bind(old)
    task = asyncio.create_task(forwarder.send({"type": "execution_complete", "messageId": "final"}))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        if rebind == "during_send":
            await forwarder.bind(replacement)
        await asyncio.wait_for(close_entered.wait(), 2)
        if rebind == "during_close":
            await forwarder.bind(replacement)
        if close_failure == "cancelled":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert await asyncio.wait_for(task, 2) is False
        old.transport.abort.assert_called_once()
        assert forwarder._ws is replacement
        replacement.close.assert_not_awaited()
        replacement.transport.abort.assert_not_called()
        assert replacement.send.await_count == 1
        assert forwarder.acknowledge("execution_complete:final") is True
        assert forwarder._event_buffer == []
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("buffered", [True, False])
async def test_cancelling_stale_live_send_drains_replacement_before_propagating(buffered):
    old, replacement = connection(), connection()
    entered = asyncio.Event()

    async def stalled_send(_payload):
        entered.set()
        await asyncio.Event().wait()

    old.send = stalled_send
    forwarder = BufferedEventForwarder(sandbox_id="test", log=MagicMock())
    await forwarder.bind(old)
    task = asyncio.create_task(
        forwarder.send({"type": "execution_complete", "messageId": "cancelled"}, buffered=buffered)
    )
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await forwarder.bind(replacement)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert forwarder._ws is replacement
        replacement.close.assert_not_awaited()
        replacement.transport.abort.assert_not_called()
        assert replacement.send.await_count == int(buffered)
        assert forwarder._event_buffer == []
        if buffered:
            assert forwarder.acknowledge("execution_complete:cancelled") is True
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
