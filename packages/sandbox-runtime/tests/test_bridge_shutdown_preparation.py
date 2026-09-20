"""Shutdown-preparation runtime fencing and execution-stop tests."""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.base import TurnOutcome
from sandbox_runtime.push_operation import PushRequest, PushResult
from tests.conftest import ScriptedHarness

GENERATION = {"sandboxId": "sandbox-1", "createdAt": 1000}
MAX_SAFE_GENERATION_CREATED_AT = 9_007_199_254_740_991


class ShutdownPreparationHarness(ScriptedHarness):
    def __init__(self, *, stopped: bool = True, wait: asyncio.Event | None = None) -> None:
        super().__init__()
        self.stopped = stopped
        self.wait = wait
        self.stop_calls = 0

    async def stop_execution(self, timeout_seconds: float) -> bool:
        self.stop_calls += 1
        if self.wait is not None:
            await self.wait.wait()
        return self.stopped


def make_bridge(harness: ShutdownPreparationHarness) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="token",
        harness=harness,
    )
    bridge.log = MagicMock()
    bridge._send_event = AsyncMock(return_value=True)
    return bridge


async def establish_generation(bridge: AgentBridge, generation: dict = GENERATION) -> None:
    await bridge._handle_command({"type": "sandbox_generation", "generation": generation})


def prepare_command(**overrides):
    return {
        "type": "prepare_preservation",
        "operationId": "operation-1",
        "generation": GENERATION,
        "messageId": "message-1",
        "stopByMs": time.time() * 1000 + 5_000,
        **overrides,
    }


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"sandboxId": "sandbox-1", "createdAt": 1}, GENERATION | {"createdAt": 1}),
        (
            {"sandboxId": "sandbox-1", "createdAt": 1.0},
            GENERATION | {"createdAt": 1},
        ),
        (
            {"sandboxId": "sandbox-1", "createdAt": MAX_SAFE_GENERATION_CREATED_AT},
            GENERATION | {"createdAt": MAX_SAFE_GENERATION_CREATED_AT},
        ),
        ({"sandboxId": "", "createdAt": 1}, None),
        ({"sandboxId": "sandbox-1", "createdAt": True}, None),
        ({"sandboxId": "sandbox-1", "createdAt": "1"}, None),
        ({"sandboxId": "sandbox-1", "createdAt": 0}, None),
        ({"sandboxId": "sandbox-1", "createdAt": -1}, None),
        ({"sandboxId": "sandbox-1", "createdAt": 0.5}, None),
        ({"sandboxId": "sandbox-1", "createdAt": float("nan")}, None),
        ({"sandboxId": "sandbox-1", "createdAt": float("inf")}, None),
        (
            {"sandboxId": "sandbox-1", "createdAt": MAX_SAFE_GENERATION_CREATED_AT + 1},
            None,
        ),
        ({"sandboxId": "sandbox-1", "createdAt": 10**1000}, None),
    ],
)
def test_generation_parser_matches_shared_schema_boundary(value, expected) -> None:
    assert AgentBridge._parse_generation(value) == expected


@pytest.mark.asyncio
async def test_malformed_prepare_generation_is_dropped_without_state() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    bridge._send_event.reset_mock()

    await bridge._handle_command(
        prepare_command(generation={"sandboxId": "sandbox-1", "createdAt": 0})
    )

    bridge._send_event.assert_not_awaited()
    assert not bridge.shutdown_preparation.fenced
    assert bridge.shutdown_preparation._results == {}


@pytest.mark.asyncio
async def test_malformed_prepare_generation_cannot_replay_cached_result() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())
    bridge._send_event.reset_mock()

    await bridge._handle_command(
        prepare_command(generation={"sandboxId": "sandbox-1", "createdAt": 0})
    )

    bridge._send_event.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_by_ms", [True, "later", float("nan"), float("inf"), 10**1000])
async def test_valid_generation_with_invalid_deadline_returns_invalid_command(stop_by_ms) -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    bridge._send_event.reset_mock()

    await bridge._handle_command(prepare_command(stopByMs=stop_by_ms))

    result = bridge._send_event.await_args.args[0]
    assert result["generation"] == GENERATION
    assert result["error"] == "invalid_command"
    assert result["executionStopped"] is False
    assert not bridge.shutdown_preparation.fenced


@pytest.mark.asyncio
async def test_shutdown_override_wins_when_prompt_returns_success_during_cancellation() -> None:
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    class RacingHarness(ShutdownPreparationHarness):
        async def run_prompt(self, prompt, emit):
            await emit({"type": "token", "messageId": prompt.message_id, "content": "partial"})
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                return TurnOutcome.ok(message_cost_usd=0.25)

        async def stop_execution(self, timeout_seconds: float) -> bool:
            assert cancelled.is_set()
            return True

    harness = RacingHarness()
    bridge = make_bridge(harness)
    bridge._prepare_turn = AsyncMock(return_value=(harness, None))
    bridge._persist_rotated_session_id = AsyncMock()
    await establish_generation(bridge)

    await bridge._handle_command({"type": "prompt", "messageId": "message-1"})
    await entered.wait()
    await bridge._handle_command(prepare_command())
    await asyncio.sleep(0)

    terminals = [
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "execution_complete"
    ]
    assert terminals == [
        {
            "type": "execution_complete",
            "messageId": "message-1",
            "success": False,
            "error": "sandbox_lifetime_expiring",
            "messageCostUsd": 0.25,
        }
    ]


@pytest.mark.asyncio
async def test_completed_push_with_stalled_delivery_is_buffered_once() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    bridge._send_event = AgentBridge._send_event.__get__(bridge)
    bridge._persist_rotated_session_id = AsyncMock()
    sending = asyncio.Event()
    release_delivery = asyncio.Event()
    attempted_types: list[str] = []
    ws = MagicMock()
    ws.state = State.OPEN

    async def stall_push_complete(payload: str) -> None:
        event_type = json.loads(payload)["type"]
        attempted_types.append(event_type)
        if event_type == "push_complete":
            sending.set()
            await release_delivery.wait()
            raise ConnectionError("socket closed")

    ws.send = stall_push_complete
    await bridge.event_forwarder.bind(ws)
    request = PushRequest(
        "branch",
        "acme",
        "repo",
        "HEAD:refs/heads/branch",
        "https://example.com/repo",
        "https://example.com/repo",
        False,
    )

    with patch("sandbox_runtime.bridge.PushOperation") as operation:
        operation.return_value.execute = AsyncMock(return_value=PushResult(request))
        await bridge._handle_command(
            {
                "type": "push",
                "pushSpec": {
                    "targetBranch": "branch",
                    "repoOwner": "acme",
                    "repoName": "repo",
                },
            }
        )
        await sending.wait()
        await bridge._handle_command(prepare_command(stopByMs=time.time() * 1000 + 50))

    assert attempted_types.count("push_complete") == 1
    assert "push_error" not in attempted_types
    release_delivery.set()

    async def wait_until_buffered() -> None:
        while not bridge.event_forwarder._event_buffer:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_until_buffered(), timeout=0.1)

    results = [
        event
        for event in [
            *bridge.event_forwarder._event_buffer,
            *bridge.event_forwarder._pending_acks.values(),
        ]
        if event["type"].startswith("push_")
    ]
    assert len(results) == 1
    assert results[0]["type"] == "push_complete"


@pytest.mark.asyncio
async def test_prepare_fences_before_stop_await_and_confirms_prompt_halted() -> None:
    release_stop = asyncio.Event()
    harness = ShutdownPreparationHarness(wait=release_stop)
    bridge = make_bridge(harness)
    await establish_generation(bridge)

    prompt_finished = asyncio.Event()

    async def active_prompt(_cmd):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            prompt_finished.set()
            raise

    bridge._handle_prompt = active_prompt
    await bridge._handle_command({"type": "prompt", "messageId": "message-1"})
    prompt_task = bridge.activity.current_prompt_task
    assert prompt_task is not None

    preparing = asyncio.create_task(bridge._handle_command(prepare_command()))
    await asyncio.sleep(0)
    assert bridge.shutdown_preparation.state.operation_id == "operation-1"

    await bridge._handle_command({"type": "prompt", "messageId": "late-message"})
    assert bridge.activity.current_prompt_task is prompt_task

    release_stop.set()
    await preparing
    assert prompt_finished.is_set()
    events = [call.args[0] for call in bridge._send_event.await_args_list]
    result = next(event for event in events if event["type"] == "preservation_prepared")
    assert result["type"] == "preservation_prepared"
    assert result["executionStopped"] is True
    terminal = next(
        event
        for event in events
        if event["type"] == "execution_complete" and event["messageId"] == "message-1"
    )
    assert terminal["error"] == "sandbox_lifetime_expiring"


@pytest.mark.asyncio
async def test_prepare_deadline_reports_unconfirmed_and_keeps_fence() -> None:
    harness = ShutdownPreparationHarness(wait=asyncio.Event())
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    task = asyncio.create_task(asyncio.Event().wait())
    bridge.activity.track_prompt("message-1", task)

    await bridge._handle_command(prepare_command(stopByMs=time.time() * 1000 + 20))
    with pytest.raises(asyncio.CancelledError):
        await task

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["executionStopped"] is False
    assert result["error"] == "stop_deadline_exceeded"
    assert bridge.shutdown_preparation.state.operation_id == "operation-1"


@pytest.mark.asyncio
async def test_prepare_deadline_is_not_swallowed_by_prompt_cancellation_cleanup() -> None:
    prompt_entered = asyncio.Event()
    first_cancel = asyncio.Event()
    release_cleanup = asyncio.Event()

    async def prompt_blocking_cancellation_cleanup() -> None:
        prompt_entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            first_cancel.set()
            await release_cleanup.wait()

    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    bridge._persist_rotated_session_id = AsyncMock()
    task = asyncio.create_task(prompt_blocking_cancellation_cleanup())
    bridge.activity.track_prompt("message-1", task)
    await prompt_entered.wait()

    try:
        await bridge._handle_command(prepare_command(stopByMs=time.time() * 1000 + 20))

        assert first_cancel.is_set()
        result = bridge._send_event.await_args_list[-1].args[0]
        assert result["executionStopped"] is False
        assert result["error"] == "stop_deadline_exceeded"
        bridge._persist_rotated_session_id.assert_not_awaited()
        assert bridge.shutdown_preparation.state.operation_id == "operation-1"
    finally:
        release_cleanup.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_prepare_propagates_outer_cancellation_while_joining_prompt() -> None:
    prompt_entered = asyncio.Event()
    first_cancel = asyncio.Event()
    release_cleanup = asyncio.Event()

    async def prompt_blocking_cancellation_cleanup() -> None:
        prompt_entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            first_cancel.set()
            await release_cleanup.wait()

    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    task = asyncio.create_task(prompt_blocking_cancellation_cleanup())
    bridge.activity.track_prompt("message-1", task)
    await prompt_entered.wait()
    preparing = asyncio.create_task(bridge._handle_command(prepare_command()))

    try:
        await first_cancel.wait()
        preparing.cancel()

        with pytest.raises(asyncio.CancelledError):
            await preparing
        assert not task.done()
    finally:
        release_cleanup.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_prepare_confirms_vendor_idle_after_user_stop_cancelled_bridge_task() -> None:
    class BusyAfterAbortHarness(ShutdownPreparationHarness):
        async def abort(self) -> bool:
            return True  # Request acknowledgement, not vendor-idle evidence.

    harness = BusyAfterAbortHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    task = asyncio.create_task(asyncio.Event().wait())
    bridge.activity.track_prompt("message-1", task)

    await bridge._handle_stop()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.done()

    await bridge._handle_command(prepare_command())

    assert harness.stop_calls == 1
    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["executionStopped"] is True


@pytest.mark.asyncio
async def test_duplicate_prepare_replays_result_without_stopping_twice() -> None:
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    command = prepare_command()
    bridge.activity.track_prompt("message-1", asyncio.create_task(asyncio.Event().wait()))

    await bridge._handle_command(command)
    first = bridge._send_event.await_args_list[-1].args[0]
    await bridge._handle_command(command)
    second = bridge._send_event.await_args_list[-1].args[0]

    assert first == second
    assert harness.stop_calls == 1


@pytest.mark.asyncio
async def test_new_operation_retries_unconfirmed_stop_without_clearing_fence() -> None:
    class RetryingHarness(ShutdownPreparationHarness):
        def __init__(self) -> None:
            super().__init__()
            self.outcomes = [False, True]

        async def stop_execution(self, timeout_seconds: float) -> bool:
            self.stop_calls += 1
            return self.outcomes.pop(0)

    harness = RetryingHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    bridge.activity.track_prompt("message-1", asyncio.create_task(asyncio.Event().wait()))

    await bridge._handle_command(prepare_command())
    first = next(
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "preservation_prepared"
    )
    assert first["executionStopped"] is False
    assert bridge.shutdown_preparation.state.operation_id == "operation-1"

    # The prompt task has already been cancelled and joined. A retry must
    # still ask the harness to contain its retained process owner.
    await bridge._handle_command(prepare_command(operationId="operation-2"))
    second = bridge._send_event.await_args_list[-1].args[0]
    assert second["operationId"] == "operation-2"
    assert second["executionStopped"] is True
    assert harness.stop_calls == 2
    assert bridge.shutdown_preparation.state.operation_id == "operation-2"

    await bridge._handle_command({"type": "prompt", "messageId": "still-fenced"})
    assert bridge._send_event.await_args_list[-1].args[0] == {
        "type": "execution_complete",
        "messageId": "still-fenced",
        "success": False,
        "error": "sandbox_lifetime_expiring",
    }


@pytest.mark.asyncio
async def test_prepare_never_reports_stopped_when_rotated_session_id_save_fails(tmp_path) -> None:
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    bridge.activity.track_prompt("message-1", asyncio.create_task(asyncio.Event().wait()))
    bridge.session_id_file = tmp_path / "missing" / "agent-session-id"
    bridge.legacy_session_id_file = tmp_path / "legacy-session-id"

    await bridge._handle_command(prepare_command())

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["error"] == "execution_stop_failed"
    assert result["executionStopped"] is False


@pytest.mark.asyncio
async def test_prepare_never_reports_stopped_when_session_id_read_fails() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    bridge._read_persisted_session_id = MagicMock(
        side_effect=PermissionError("session id is unreadable")
    )

    await bridge._handle_command(prepare_command())

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["error"] == "execution_stop_failed"
    assert result["executionStopped"] is False
    assert bridge.shutdown_preparation.fenced


@pytest.mark.asyncio
async def test_nonstrict_session_id_read_failure_is_logged_and_ignored() -> None:
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    error = PermissionError("session id is unreadable")
    bridge._read_persisted_session_id = MagicMock(side_effect=error)

    await bridge._persist_rotated_session_id(harness)

    bridge.log.error.assert_called_once_with("agent.session.load_error", exc=error)


@pytest.mark.asyncio
async def test_shutdown_push_refusal_keeps_invalid_request_correlation() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())
    bridge._send_event.reset_mock()

    await bridge._handle_command(
        {
            "type": "push",
            "pushSpec": {
                "targetBranch": "open-inspect/session-1",
                "repoOwner": "acme",
                "repoName": "api",
            },
        }
    )

    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert event["branchName"] == "open-inspect/session-1"
    assert event["repoOwner"] == "acme"
    assert event["repoName"] == "api"
    assert event["error"] == "Push failed — the sandbox is shutting down."


@pytest.mark.asyncio
async def test_prepare_cancels_active_push_before_acknowledging() -> None:
    push_started = asyncio.Event()
    push_cleaned = asyncio.Event()

    class CleanupCheckingHarness(ShutdownPreparationHarness):
        async def stop_execution(self, timeout_seconds: float) -> bool:
            assert push_cleaned.is_set()
            return await super().stop_execution(timeout_seconds)

    async def block_push(_spec):
        push_started.set()
        try:
            await asyncio.Future()
        finally:
            push_cleaned.set()

    bridge = make_bridge(CleanupCheckingHarness())
    await establish_generation(bridge)
    push_command = {
        "type": "push",
        "pushSpec": {
            "targetBranch": "open-inspect/session-1",
            "repoOwner": "acme",
            "repoName": "api",
            "refspec": "HEAD:refs/heads/open-inspect/session-1",
            "remoteUrl": "https://token@example.com/acme/api.git",
            "redactedRemoteUrl": "https://***@example.com/acme/api.git",
            "force": False,
        },
    }

    with patch("sandbox_runtime.bridge.PushOperation") as operation:
        operation.return_value.execute = AsyncMock(side_effect=block_push)
        await bridge._handle_command(push_command)
        await push_started.wait()
        await bridge._handle_command(prepare_command())

    assert push_cleaned.is_set()
    assert not bridge.activity.push_tasks
    events = [call.args[0] for call in bridge._send_event.await_args_list]
    push_error = next(event for event in events if event["type"] == "push_error")
    prepared = next(event for event in events if event["type"] == "preservation_prepared")
    assert push_error["error"] == "Push failed — the sandbox is shutting down."
    assert prepared["executionStopped"] is True
    assert events.index(push_error) < events.index(prepared)


@pytest.mark.asyncio
async def test_same_generation_reconnect_does_not_clear_fence_but_new_generation_does() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())

    await establish_generation(bridge)
    assert bridge.shutdown_preparation.state.operation_id == "operation-1"

    next_generation = {"sandboxId": "sandbox-1", "createdAt": 2000}
    await establish_generation(bridge, next_generation)
    assert not bridge.shutdown_preparation.fenced
    assert bridge.shutdown_preparation._results == {}


@pytest.mark.asyncio
async def test_late_generation_prepare_cannot_fence_current_generation() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    await establish_generation(bridge, {"sandboxId": "sandbox-1", "createdAt": 2000})

    await bridge._handle_command(prepare_command())

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["executionStopped"] is False
    assert result["error"] == "generation_mismatch"
    assert not bridge.shutdown_preparation.fenced


def test_ready_advertises_shutdown_protocol_version() -> None:
    bridge = make_bridge(ShutdownPreparationHarness())
    assert bridge._build_ready_event()["preservationProtocolVersion"] == 1
