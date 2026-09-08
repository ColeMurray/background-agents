"""The turn's final cumulative cost rides on execution_complete."""

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.bridge import AgentBridge


@pytest.fixture
def bridge() -> AgentBridge:
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    b.opencode_session_id = "oc-session-123"
    b._configure_git_identity = AsyncMock()
    b._send_event = AsyncMock()
    return b


def _prompt_command() -> dict:
    return {
        "messageId": "msg-1",
        "content": "fix the bug",
        "model": "claude-sonnet-4-6",
        "author": {"userId": "user-1", "gitIdentity": {"mode": "agent-only"}},
    }


def _completion(bridge: AgentBridge) -> dict:
    events = [call.args[0] for call in bridge._send_event.await_args_list]
    return next(event for event in events if event["type"] == "execution_complete")


class TestExecutionCompleteCostReport:
    @pytest.mark.asyncio
    async def test_stopped_turn_reports_cost_once(self, bridge: AgentBridge):
        reported = asyncio.Event()

        async def stream(*_args, **_kwargs):
            yield {"type": "step_finish", "messageId": "msg-1", "cost": 0.5, "messageCostUsd": 0.5}
            reported.set()
            await asyncio.Event().wait()

        bridge._stream_opencode_response_sse = stream
        bridge._request_opencode_stop = AsyncMock()
        bridge.diff_refresh = Mock()
        await bridge._handle_command({"type": "prompt", **_prompt_command()})
        await asyncio.wait_for(reported.wait(), timeout=1)
        task = bridge._current_prompt_task
        assert task is not None
        await bridge._handle_stop()
        await task
        await asyncio.sleep(0)  # Let the done callback run as well.

        events = [call.args[0] for call in bridge._send_event.await_args_list]
        completions = [event for event in events if event["type"] == "execution_complete"]
        assert completions == [
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": False,
                "error": "Task was cancelled",
                "messageCostUsd": 0.5,
            }
        ]

    @pytest.mark.asyncio
    async def test_carries_the_last_cumulative_report(self, bridge: AgentBridge):
        async def stream(*_args, **_kwargs):
            yield {"type": "step_finish", "messageId": "msg-1", "cost": 0.5, "messageCostUsd": 0.5}
            yield {
                "type": "step_finish",
                "messageId": "msg-1",
                "cost": 0.25,
                "messageCostUsd": 0.75,
            }

        bridge._stream_opencode_response_sse = stream

        await bridge._handle_prompt(_prompt_command())

        completion = _completion(bridge)
        assert completion["success"] is True
        assert completion["messageCostUsd"] == 0.75

    @pytest.mark.asyncio
    async def test_carries_the_report_on_failure(self, bridge: AgentBridge):
        async def stream(*_args, **_kwargs):
            yield {"type": "step_finish", "messageId": "msg-1", "cost": 0.5, "messageCostUsd": 0.5}
            yield {"type": "error", "messageId": "msg-1", "error": "boom"}

        bridge._stream_opencode_response_sse = stream

        await bridge._handle_prompt(_prompt_command())

        completion = _completion(bridge)
        assert completion["success"] is False
        assert completion["messageCostUsd"] == 0.5

    @pytest.mark.asyncio
    async def test_omits_the_field_when_no_step_reported(self, bridge: AgentBridge):
        async def stream(*_args, **_kwargs):
            yield {"type": "token", "messageId": "msg-1", "content": "hi"}

        bridge._stream_opencode_response_sse = stream

        await bridge._handle_prompt(_prompt_command())

        assert "messageCostUsd" not in _completion(bridge)
