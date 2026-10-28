"""Command admission acknowledgements and bridge-lifetime replay protection."""

import asyncio
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import ScriptedHarness


@pytest.fixture
async def bridge():
    harness = ScriptedHarness()
    harness.abort = AsyncMock(return_value=True)
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        harness=harness,
    )
    bridge.diff_refresh = MagicMock()
    bridge._send_event = AsyncMock(return_value=True)

    async def pending_operation(_cmd):
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    bridge._handle_prompt = AsyncMock(side_effect=pending_operation)
    bridge._handle_push = AsyncMock(side_effect=pending_operation)
    yield bridge
    await bridge.activity.shutdown()


@pytest.mark.parametrize("command_type", ["prompt", "push", "stop"])
async def test_duplicates_ack_once_per_delivery_after_dispatch(bridge, command_type, monkeypatch):
    command = {"type": command_type, "commandId": "cmd-1", "messageId": "msg-1"}
    dispatch = AsyncMock(wraps=bridge._dispatch_command)
    bridge._dispatch_command = dispatch
    monkeypatch.setattr("sandbox_runtime.bridge.time.time", lambda: 1_800_000_000.125)

    async def send(event):
        if event["type"] == "command_ack":
            assert dispatch.await_count == 1
            assert "cmd-1" in bridge._accepted_command_ids
            if command_type == "prompt":
                assert bridge.activity.current_prompt_task is not None
                bridge._handle_prompt.assert_not_awaited()
            elif command_type == "push":
                assert len(bridge.activity.push_tasks) == 1
                bridge._handle_push.assert_not_awaited()

    bridge._send_event.side_effect = send
    await bridge._handle_command(command)
    await bridge._handle_command(command)

    dispatch.assert_awaited_once_with(command)
    acks = [
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "command_ack"
    ]
    assert (
        acks == [{"type": "command_ack", "commandId": "cmd-1", "timestamp": 1_800_000_000_125}] * 2
    )


@pytest.mark.parametrize("command_type", ["prompt", "push", "stop"])
@pytest.mark.parametrize("ack_error", [RuntimeError, asyncio.CancelledError])
async def test_failed_ack_does_not_allow_redispatch(bridge, command_type, ack_error):
    command = {"type": command_type, "commandId": "cmd-1", "messageId": "msg-1"}
    bridge._dispatch_command = AsyncMock(wraps=bridge._dispatch_command)

    async def fail_ack(event):
        if event["type"] == "command_ack":
            raise ack_error()

    bridge._send_event.side_effect = fail_ack
    with pytest.raises(ack_error):
        await bridge._handle_command(command)

    bridge._send_event.side_effect = None
    await bridge._handle_command(command)

    bridge._dispatch_command.assert_awaited_once_with(command)
    assert bridge._send_event.await_args.args[0]["type"] == "command_ack"


@pytest.mark.parametrize("command_type", ["prompt", "push", "stop"])
async def test_lost_ack_and_reconnect_reack_without_execution(bridge, command_type, monkeypatch):
    command = {"type": command_type, "commandId": "cmd-1", "messageId": "msg-1"}
    bridge._send_event = AgentBridge._send_event.__get__(bridge)
    bridge._dispatch_command = AsyncMock(wraps=bridge._dispatch_command)
    bridge.boot_attach.on_connect = AsyncMock()
    bridge._heartbeat_loop = AsyncMock()

    class WebSocket:
        state = State.OPEN
        close_code = 1000

        def __init__(self, lose_ack):
            self.lose_ack = lose_ack
            self.sent = []

        async def send(self, data):
            event = json.loads(data)
            if not (self.lose_ack and event["type"] == "command_ack"):
                self.sent.append(event)

        async def __aiter__(self):
            yield json.dumps(command)
            yield json.dumps(command)

    first = WebSocket(lose_ack=True)
    second = WebSocket(lose_ack=False)
    connections = iter([first, second])

    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        yield next(connections)

    monkeypatch.setattr("sandbox_runtime.bridge.websockets.connect", connect)
    await bridge._connect_and_run()
    await bridge._connect_and_run()

    bridge._dispatch_command.assert_awaited_once_with(command)
    assert not any(event["type"] == "command_ack" for event in first.sent)
    acks = [event for event in second.sent if event["type"] == "command_ack"]
    assert len(acks) == 2
    assert all(event["commandId"] == "cmd-1" and "ackId" not in event for event in acks)
    assert all(
        event["type"] != "command_ack" for event in bridge.event_forwarder._pending_acks.values()
    )
    await asyncio.sleep(0)
    if command_type == "prompt":
        bridge._handle_prompt.assert_awaited_once_with(command)
    elif command_type == "push":
        bridge._handle_push.assert_awaited_once_with(command)


@pytest.mark.parametrize("command_type", ["prompt", "push", "stop"])
async def test_dispatch_failure_is_not_recorded_or_acked(bridge, command_type):
    command = {"type": command_type, "commandId": "cmd-1"}
    bridge._dispatch_command = AsyncMock(side_effect=[RuntimeError("not admitted"), None])

    with pytest.raises(RuntimeError, match="not admitted"):
        await bridge._handle_command(command)

    bridge._send_event.assert_not_awaited()
    assert bridge._accepted_command_ids == set()
    await bridge._handle_command(command)
    assert bridge._dispatch_command.await_count == 2
    assert bridge._send_event.await_args.args[0]["type"] == "command_ack"


@pytest.mark.parametrize("command_type", ["prompt", "push", "stop"])
async def test_legacy_commands_execute_every_delivery_without_ack(bridge, command_type):
    command = {"type": command_type}
    if command_type == "prompt":
        command["messageId"] = "msg-1"
    bridge._dispatch_command = AsyncMock(wraps=bridge._dispatch_command)

    await bridge._handle_command(command)
    await bridge._handle_command(command)

    assert bridge._dispatch_command.await_count == 2
    assert bridge._accepted_command_ids == set()
    assert all(call.args[0]["type"] != "command_ack" for call in bridge._send_event.await_args_list)
    if command_type == "stop":
        assert bridge.harness.abort.await_count == 2


async def test_boot_handled_push_is_deduplicated_before_boot_handler(bridge):
    bridge.boot_attach._boot_ready.clear()
    bridge.boot_attach.handle_command = AsyncMock(wraps=bridge.boot_attach.handle_command)
    command = {"type": "push", "commandId": "cmd-1"}

    await bridge._handle_command(command)
    await bridge._handle_command(command)
    bridge.boot_attach._boot_ready.set()
    await bridge._handle_command(command)

    bridge.boot_attach.handle_command.assert_awaited_once_with(command)
    bridge._handle_push.assert_not_called()
    assert [call.args[0]["type"] for call in bridge._send_event.await_args_list] == [
        "push_error",
        "command_ack",
        "command_ack",
        "command_ack",
    ]


@pytest.mark.parametrize("command_type", ["prompt", "push"])
async def test_completed_work_remains_deduplicated(bridge, command_type):
    operation = getattr(bridge, f"_handle_{command_type}")
    operation.side_effect = None
    operation.return_value = (
        {"type": "execution_complete", "messageId": "msg-1", "success": True}
        if command_type == "prompt"
        else {"type": "push_complete", "branchName": "branch"}
    )
    command = {"type": command_type, "commandId": "cmd-1", "messageId": "msg-1"}
    await bridge._handle_command(command)
    task = (
        bridge.activity.current_prompt_task
        if command_type == "prompt"
        else bridge.activity.push_tasks[0]
    )
    await task
    await asyncio.sleep(0)
    await bridge._handle_command(command)

    operation.assert_awaited_once_with(command)
    assert bridge.activity.current_prompt_task is None
    assert bridge.activity.push_tasks == ()


@pytest.mark.parametrize("targeted", [False, True])
async def test_duplicate_stop_does_not_abort_the_next_prompt(bridge, targeted):
    command = {"type": "stop", "commandId": "stop-1"}
    if targeted:
        command["messageId"] = "msg-1"
    await bridge._handle_command({"type": "prompt", "messageId": "msg-1"})
    old_task = bridge.activity.current_prompt_task
    await bridge._handle_command(command)
    await asyncio.gather(old_task, return_exceptions=True)
    await bridge._handle_command({"type": "prompt", "messageId": "msg-2"})
    new_task = bridge.activity.current_prompt_task
    await bridge._handle_command(command)

    assert not new_task.cancelling()
    bridge.harness.abort.assert_awaited_once()


@pytest.mark.parametrize("active_message_id", [None, "other-message"])
async def test_targeted_stop_without_match_settles_only_requested_message(
    bridge, active_message_id
):
    if active_message_id is not None:
        bridge._handle_prompt.side_effect = None
        bridge._handle_prompt.return_value = {
            "type": "execution_complete",
            "messageId": active_message_id,
            "success": True,
        }
        await bridge._handle_command({"type": "prompt", "messageId": active_message_id})
    task = bridge.activity.current_prompt_task

    await bridge._handle_command(
        {"type": "stop", "commandId": "stop-1", "messageId": "never-delivered"}
    )

    bridge.harness.abort.assert_not_awaited()
    assert bridge.activity.current_prompt_task is task
    if task is not None:
        assert not task.cancelling()
    assert bridge._send_event.await_args_list[0].args[0] == {
        "type": "execution_complete",
        "messageId": "never-delivered",
        "success": False,
        "error": "stopped",
    }
    assert bridge._send_event.await_args_list[1].args[0]["type"] == "command_ack"
    if task is not None:
        await task
        await asyncio.sleep(0)
        assert bridge._send_event.await_args.args[0] == {
            "type": "execution_complete",
            "messageId": active_message_id,
            "success": True,
        }


@pytest.mark.parametrize("booting", [False, True])
async def test_targeted_stop_cancels_matching_prompt_once(bridge, booting):
    if booting:
        bridge.boot_attach._boot_ready.clear()
        bridge.boot_attach.harness = None
        bridge._handle_prompt = AgentBridge._handle_prompt.__get__(bridge)
    await bridge._handle_command({"type": "prompt", "commandId": "prompt-1", "messageId": "msg-1"})
    task = bridge.activity.current_prompt_task
    await asyncio.sleep(0)
    await bridge._handle_command({"type": "stop", "commandId": "stop-1", "messageId": "msg-1"})
    await asyncio.gather(task, return_exceptions=True)
    await asyncio.sleep(0)

    terminals = [
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "execution_complete"
    ]
    assert terminals == [
        {"type": "execution_complete", "messageId": "msg-1", "success": False, "error": "stopped"}
    ]
    if not booting:
        bridge.harness.abort.assert_awaited_once()
