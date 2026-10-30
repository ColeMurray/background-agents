"""`ready` names the owed prompt only after the harness contains a predecessor."""

import asyncio

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.claude import ClaudeHarness
from sandbox_runtime.harness.codex import CodexHarness
from tests.conftest import ScriptedHarness


def _bridge(harness) -> AgentBridge:
    return AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        harness=harness,
    )


def test_ready_omits_the_report_when_the_harness_has_not_contained_a_predecessor() -> None:
    event = _bridge(ScriptedHarness())._build_ready_event()
    assert "activeMessageId" not in event


@pytest.mark.asyncio
async def test_ready_names_the_running_prompt_before_it_is_sent() -> None:
    harness = ScriptedHarness()
    harness.contains_inherited_execution = True
    bridge = _bridge(harness)

    async def operation() -> dict:
        await asyncio.Event().wait()
        return {"type": "execution_complete", "messageId": "m-run", "success": True}

    bridge.activity.start_prompt("m-run", operation)
    await asyncio.sleep(0)

    assert bridge._build_ready_event()["activeMessageId"] == "m-run"
    task = bridge.activity.current_prompt_task
    assert task is not None
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_ready_names_a_terminal_the_forwarder_has_not_accepted_yet() -> None:
    harness = ScriptedHarness()
    harness.contains_inherited_execution = True
    bridge = _bridge(harness)
    released = asyncio.Event()

    async def send(event: dict) -> bool:
        await released.wait()
        return True

    bridge.event_forwarder.send = send  # type: ignore[method-assign]

    async def operation() -> dict:
        return {"type": "execution_complete", "messageId": "m-done", "success": True}

    bridge.activity.start_prompt("m-done", operation)
    for _ in range(20):
        if bridge.activity.current_prompt_message_id is None:
            break
        await asyncio.sleep(0.01)

    assert bridge.activity.current_prompt_message_id is None
    assert bridge._build_ready_event()["activeMessageId"] == "m-done"

    released.set()
    for _ in range(5):
        if not bridge.activity.undelivered_terminal_message_ids():
            break
        await asyncio.sleep(0)


def test_claude_and_codex_declare_containment() -> None:
    assert ClaudeHarness.contains_inherited_execution is True
    assert CodexHarness.contains_inherited_execution is True
