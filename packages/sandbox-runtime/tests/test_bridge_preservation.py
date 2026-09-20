"""Final-preservation runtime fencing and execution-stop tests."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import ScriptedHarness

GENERATION = {"sandboxId": "sandbox-1", "createdAt": 1000}


class PreservationHarness(ScriptedHarness):
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


def make_bridge(harness: PreservationHarness) -> AgentBridge:
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


@pytest.mark.asyncio
async def test_prepare_fences_before_stop_await_and_confirms_prompt_halted() -> None:
    release_stop = asyncio.Event()
    harness = PreservationHarness(wait=release_stop)
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
    prompt_task = bridge._current_prompt_task
    assert prompt_task is not None

    preparing = asyncio.create_task(bridge._handle_command(prepare_command()))
    await asyncio.sleep(0)
    assert bridge._preservation_operation_id == "operation-1"

    await bridge._handle_command({"type": "prompt", "messageId": "late-message"})
    assert bridge._current_prompt_task is prompt_task

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
    harness = PreservationHarness(wait=asyncio.Event())
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    task = asyncio.create_task(asyncio.Event().wait())
    bridge._current_prompt_task = task

    await bridge._handle_command(prepare_command(stopByMs=time.time() * 1000 + 20))
    with pytest.raises(asyncio.CancelledError):
        await task

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["executionStopped"] is False
    assert result["error"] == "stop_deadline_exceeded"
    assert bridge._preservation_operation_id == "operation-1"


@pytest.mark.asyncio
async def test_prepare_confirms_vendor_idle_after_user_stop_cancelled_bridge_task() -> None:
    class BusyAfterAbortHarness(PreservationHarness):
        async def abort(self) -> bool:
            return True  # Request acknowledgement, not vendor-idle evidence.

    harness = BusyAfterAbortHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    task = asyncio.create_task(asyncio.Event().wait())
    bridge._current_prompt_task = task

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
    harness = PreservationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    command = prepare_command()
    bridge._current_prompt_task = asyncio.create_task(asyncio.Event().wait())

    await bridge._handle_command(command)
    first = bridge._send_event.await_args_list[-1].args[0]
    await bridge._handle_command(command)
    second = bridge._send_event.await_args_list[-1].args[0]

    assert first == second
    assert harness.stop_calls == 1


@pytest.mark.asyncio
async def test_new_operation_retries_unconfirmed_stop_without_clearing_fence() -> None:
    class RetryingHarness(PreservationHarness):
        def __init__(self) -> None:
            super().__init__()
            self.outcomes = [False, True]

        async def stop_execution(self, timeout_seconds: float) -> bool:
            self.stop_calls += 1
            return self.outcomes.pop(0)

    harness = RetryingHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    bridge._current_prompt_task = asyncio.create_task(asyncio.Event().wait())

    await bridge._handle_command(prepare_command())
    first = next(
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "preservation_prepared"
    )
    assert first["executionStopped"] is False
    assert bridge._preservation_operation_id == "operation-1"

    # The prompt task has already been cancelled and joined. A retry must
    # still ask the harness to contain its retained process owner.
    bridge._current_prompt_task = None
    await bridge._handle_command(prepare_command(operationId="operation-2"))
    second = bridge._send_event.await_args_list[-1].args[0]
    assert second["operationId"] == "operation-2"
    assert second["executionStopped"] is True
    assert harness.stop_calls == 2
    assert bridge._preservation_operation_id == "operation-2"

    await bridge._handle_command({"type": "prompt", "messageId": "still-fenced"})
    assert bridge._send_event.await_args_list[-1].args[0] == {
        "type": "execution_complete",
        "messageId": "still-fenced",
        "success": False,
        "error": "sandbox_lifetime_expiring",
    }


@pytest.mark.asyncio
async def test_prepare_never_reports_stopped_when_rotated_session_id_save_fails(tmp_path) -> None:
    harness = PreservationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    bridge._current_prompt_task = asyncio.create_task(asyncio.Event().wait())
    bridge.session_id_file = tmp_path / "missing" / "agent-session-id"
    bridge.legacy_session_id_file = tmp_path / "legacy-session-id"

    await bridge._handle_command(prepare_command())

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["error"] == "execution_stop_failed"
    assert result["executionStopped"] is False


@pytest.mark.asyncio
async def test_preservation_push_refusal_keeps_invalid_request_correlation() -> None:
    bridge = make_bridge(PreservationHarness())
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
    assert "preservation is in progress" in event["error"]


@pytest.mark.asyncio
async def test_prepare_cancels_active_push_before_acknowledging() -> None:
    push_started = asyncio.Event()
    push_cleaned = asyncio.Event()

    class CleanupCheckingHarness(PreservationHarness):
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
    assert not bridge._push_tasks
    events = [call.args[0] for call in bridge._send_event.await_args_list]
    push_error = next(event for event in events if event["type"] == "push_error")
    prepared = next(event for event in events if event["type"] == "preservation_prepared")
    assert "preservation is in progress" in push_error["error"]
    assert prepared["executionStopped"] is True
    assert events.index(push_error) < events.index(prepared)


@pytest.mark.asyncio
async def test_same_generation_reconnect_does_not_clear_fence_but_new_generation_does() -> None:
    bridge = make_bridge(PreservationHarness())
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())

    await establish_generation(bridge)
    assert bridge._preservation_operation_id == "operation-1"

    next_generation = {"sandboxId": "sandbox-1", "createdAt": 2000}
    await establish_generation(bridge, next_generation)
    assert bridge._preservation_operation_id is None
    assert bridge._preservation_results == {}


@pytest.mark.asyncio
async def test_late_generation_prepare_cannot_fence_current_generation() -> None:
    bridge = make_bridge(PreservationHarness())
    await establish_generation(bridge, {"sandboxId": "sandbox-1", "createdAt": 2000})

    await bridge._handle_command(prepare_command())

    result = bridge._send_event.await_args_list[-1].args[0]
    assert result["executionStopped"] is False
    assert result["error"] == "generation_mismatch"
    assert bridge._preservation_operation_id is None


def test_ready_advertises_preservation_protocol_version() -> None:
    bridge = make_bridge(PreservationHarness())
    assert bridge._build_ready_event()["preservationProtocolVersion"] == 1
