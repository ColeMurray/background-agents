"""Stop delivery through the real receive loop, activity owner, and forwarder."""

import asyncio
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import ScriptedHarness


class QueuedSocket:
    state = State.OPEN
    close_code = 1000

    def __init__(self):
        self.commands = asyncio.Queue()
        self.sent = []
        self.send_hook = None

    async def send(self, data):
        event = json.loads(data)
        if self.send_hook is not None and not await self.send_hook(event):
            return
        self.sent.append(event)

    async def __aiter__(self):
        while (command := await self.commands.get()) is not None:
            yield json.dumps(command)


async def wait(event):
    await asyncio.wait_for(event.wait(), timeout=1)


@pytest.fixture
async def connected_bridge(monkeypatch):
    harness = ScriptedHarness()
    harness.stop_execution = AsyncMock(return_value=True)
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        harness=harness,
    )
    bridge.diff_refresh = MagicMock()
    bridge.boot_attach.on_connect = AsyncMock()
    bridge._heartbeat_loop = AsyncMock()
    ws = QueuedSocket()

    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        yield ws

    monkeypatch.setattr("sandbox_runtime.bridge.websockets.connect", connect)
    monkeypatch.setattr(
        "sandbox_runtime.event_forwarder.STOP_CONFIRMATION_RETRY_INTERVAL_SECONDS", 0.01
    )
    retry_loop = bridge.event_forwarder.retry_stop_confirmations
    retry_tasks = []

    async def retry(connection):
        retry_tasks.append(asyncio.current_task())
        await retry_loop(connection)

    bridge.event_forwarder.retry_stop_confirmations = retry
    running = asyncio.create_task(bridge._connect_and_run())
    try:
        yield bridge, ws, running
    finally:
        ws.commands.put_nowait(None)
        await running
        await bridge.activity.shutdown()
        assert not bridge.activity._deliveries
        assert not bridge.event_forwarder._in_flight_acks
        assert retry_tasks and all(task.done() for task in retry_tasks)


@pytest.mark.parametrize("command_ids", [False, True], ids=["legacy", "command-id"])
async def test_queued_stop_bypasses_receipt_but_serializes_containment(
    connected_bridge, command_ids
):
    bridge, ws, running = connected_bridge
    prompt_started = asyncio.Event()
    receipt_started = asyncio.Event()
    confirmation_started = asyncio.Event()
    release_writes = asyncio.Event()
    containment_started = asyncio.Event()
    release_containment = asyncio.Event()
    next_prompt_started = asyncio.Event()

    async def prompt(command):
        if command["messageId"] == "msg-1":
            prompt_started.set()
        else:
            next_prompt_started.set()
        await asyncio.Event().wait()

    async def contain(_remaining):
        containment_started.set()
        await release_containment.wait()
        return True

    async def send(event):
        if event["type"] in ("command_ack", "stop_confirmed"):
            if event["type"] == "command_ack":
                receipt_started.set()
            else:
                if command_ids:
                    assert "stop-1" in bridge._accepted_command_ids
                confirmation_started.set()
            await release_writes.wait()
            raise ConnectionError("old socket write failed after disconnect")
        return True

    bridge._handle_prompt = prompt
    bridge.harness.stop_execution.side_effect = contain
    ws.send_hook = send
    ws.commands.put_nowait(
        {
            "type": "prompt",
            "messageId": "msg-1",
            **({"commandId": "prompt-1"} if command_ids else {}),
        }
    )
    await wait(prompt_started)
    if command_ids:
        await wait(receipt_started)
    stop = {"type": "stop", "messageId": "msg-1"}
    if command_ids:
        stop["commandId"] = "stop-1"
    ws.commands.put_nowait(stop)
    await wait(containment_started)
    if command_ids:
        ws.commands.put_nowait(stop)
    ws.commands.put_nowait({"type": "prompt", "messageId": "msg-2"})
    await asyncio.sleep(0)
    assert not next_prompt_started.is_set()
    assert not confirmation_started.is_set()
    release_containment.set()
    await wait(next_prompt_started)
    await wait(confirmation_started)
    bridge.harness.stop_execution.assert_awaited_once()
    assert not release_writes.is_set()

    # The connection owns retries, not durable outbound delivery tasks.
    deliveries = tuple(bridge.activity._deliveries)
    ws.commands.put_nowait(None)
    await running
    assert all(not task.done() for task in deliveries)
    replacement = QueuedSocket()
    await bridge.event_forwarder.bind(replacement)
    release_writes.set()
    await bridge.activity._join_deliveries(asyncio.get_running_loop().time() + 1)
    confirmations = [event for event in replacement.sent if event["type"] == "stop_confirmed"]
    assert len(confirmations) == 1
    assert bridge.event_forwarder.acknowledge(confirmations[0]["ackId"])
    bridge.event_forwarder.unbind()


@pytest.mark.parametrize("confirmation_failure", ["drop", "raise"])
@pytest.mark.parametrize("receipt_dropped", [False, True])
async def test_stop_confirmation_recovers_on_same_socket_without_recontainment(
    connected_bridge, confirmation_failure, receipt_dropped
):
    bridge, ws, _running = connected_bridge
    command = {"type": "stop", "messageId": "msg-1", "commandId": "stop-1"}
    attempts = []
    receipts = []
    recovered = asyncio.Event()

    async def send(event):
        if event["type"] == "command_ack":
            receipts.append(event)
            if receipt_dropped and len(receipts) == 1:
                ws.commands.put_nowait(command)
                return False
        if event["type"] == "stop_confirmed":
            attempts.append(event)
            if len(attempts) == 1:
                if confirmation_failure == "raise":
                    raise RuntimeError("application failed to accept confirmation")
                return False
            ws.commands.put_nowait({"type": "ack", "ackId": event["ackId"]})
            # A following command proves that the receive loop consumed the ACK.
            ws.commands.put_nowait({"type": "git_sync_complete"})
            recovered.set()
        return True

    ws.send_hook = send
    ws.commands.put_nowait(command)
    await wait(recovered)
    await wait(bridge.git_sync_complete)
    assert attempts[0] == attempts[1]
    assert len(receipts) == (2 if receipt_dropped else 1)
    bridge.harness.stop_execution.assert_awaited_once()
    assert bridge.event_forwarder._pending_acks == {}
    await asyncio.sleep(0.04)
    assert len(attempts) == 2
    assert bridge._connection_count == 1


async def test_confirmation_retry_is_independent_of_parked_command_receipt(connected_bridge):
    bridge, ws, _running = connected_bridge
    receipt_started = asyncio.Event()
    release_receipt = asyncio.Event()
    retried = asyncio.Event()
    attempts = 0

    async def send(event):
        nonlocal attempts
        if event["type"] == "command_ack":
            receipt_started.set()
            await release_receipt.wait()
        if event["type"] == "stop_confirmed":
            attempts += 1
            if attempts == 1:
                return False
            ws.commands.put_nowait({"type": "ack", "ackId": event["ackId"]})
            retried.set()
        return True

    ws.send_hook = send
    command = {"type": "stop", "messageId": "msg-1", "commandId": "stop-1"}
    ws.commands.put_nowait(command)
    await wait(receipt_started)
    ws.commands.put_nowait(command)
    await wait(retried)
    assert not release_receipt.is_set()
    bridge.harness.stop_execution.assert_awaited_once()
    release_receipt.set()
