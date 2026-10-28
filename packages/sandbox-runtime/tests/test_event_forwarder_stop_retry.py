"""Connection-owned retries of retained stop results, not generic reliable events."""

import asyncio
import contextlib

import pytest

from sandbox_runtime.event_forwarder import STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS
from tests.event_forwarder_fakes import make_forwarder, open_ws, sent_events, settle
from tests.test_event_forwarder import GatedWs


async def test_stop_retry_excludes_in_flight_and_preserves_pending_on_cancellation(monkeypatch):
    assert STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS <= 2
    monkeypatch.setattr(
        "sandbox_runtime.event_forwarder.STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS", 0.01
    )
    forwarder = make_forwarder()
    ws = GatedWs()
    await forwarder.bind(ws)
    retry = asyncio.create_task(forwarder.retry_stop_confirmations(ws))
    direct = asyncio.create_task(forwarder.send({"type": "stop_confirmed", "messageId": "msg-1"}))
    try:
        await asyncio.sleep(0.04)
        assert len(ws.calls) == 1
        ws.release(0)
        await direct
        await asyncio.sleep(0.04)
        assert len(ws.calls) == 2
        assert len(forwarder._in_flight_acks) == 1
        # A slow retry is one attempt, not a new task on every timer tick.
        await asyncio.sleep(0.04)
        assert len(ws.calls) == 2
    finally:
        forwarder.unbind()
        retry.cancel()
        direct.cancel()
        await asyncio.gather(retry, direct, return_exceptions=True)

    assert not forwarder._in_flight_acks
    replacement = open_ws()
    await forwarder.bind(replacement)
    assert sent_events(replacement) == [ws.calls[0]]
    assert forwarder.acknowledge(ws.calls[0]["ackId"])
    await forwarder.bind(open_ws())
    assert not forwarder._pending_acks


@pytest.mark.parametrize("failure", [False, True])
async def test_ack_during_retry_is_not_resurrected(monkeypatch, failure):
    monkeypatch.setattr(
        "sandbox_runtime.event_forwarder.STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS", 0.01
    )
    forwarder = make_forwarder()
    first = open_ws()
    await forwarder.bind(first)
    await forwarder.send({"type": "stop_confirmed", "messageId": "msg-1"})
    ws = GatedWs()
    # Keep the same bound connection; gate just its subsequent writes.
    first.send = ws.send
    retry = asyncio.create_task(forwarder.retry_stop_confirmations(first))
    try:
        await asyncio.sleep(0.04)
        assert len(ws.calls) == 1
        assert forwarder.acknowledge(ws.calls[0]["ackId"])
        ws.release(0, RuntimeError("failed after ACK") if failure else None)
        await asyncio.sleep(0.04)
        assert len(ws.calls) == 1
        assert not forwarder._pending_acks
        assert not forwarder._in_flight_acks
    finally:
        retry.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await retry


async def test_retry_only_sends_stops_and_exits_after_unbind(monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.event_forwarder.STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS", 0.01
    )
    forwarder = make_forwarder()
    ws = open_ws()
    await forwarder.bind(ws)
    await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
    await forwarder.send({"type": "stop_confirmed", "messageId": "msg-1"})
    retry = asyncio.create_task(forwarder.retry_stop_confirmations(ws))
    try:
        await asyncio.sleep(0.04)
        events = sent_events(ws)
        assert len(events) > 2
        assert all(event["type"] == "stop_confirmed" for event in events[2:])
        forwarder.unbind()
        await asyncio.wait_for(retry, timeout=1)
        count = len(sent_events(ws))
        await settle()
        assert len(sent_events(ws)) == count
    finally:
        retry.cancel()
        await asyncio.gather(retry, return_exceptions=True)
