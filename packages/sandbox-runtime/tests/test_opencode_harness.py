"""OpenCode outcome evidence and bridge-owned lifetime regression tests."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.harness import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient, SSEInactivityTimeoutError

SESSION_ID = "oc-session"
USER_MESSAGE_ID = "msg_user"
ASSISTANT_MESSAGE_ID = "msg_assistant"


def event(event_type: str, **properties: object) -> dict:
    return {"type": event_type, "properties": properties}


def assistant(**extra: object) -> dict:
    return event(
        "message.updated",
        info={
            "id": ASSISTANT_MESSAGE_ID,
            "parentID": USER_MESSAGE_ID,
            "sessionID": SESSION_ID,
            "role": "assistant",
            **extra,
        },
    )


def part(part_type: str, **extra: object) -> dict:
    return event(
        "message.part.updated",
        part={
            "type": part_type,
            "id": f"part_{part_type}",
            "messageID": ASSISTANT_MESSAGE_ID,
            "sessionID": SESSION_ID,
            **extra,
        },
    )


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.harness.opencode_stream.OpenCodeIdentifier.ascending",
        lambda _: USER_MESSAGE_ID,
    )
    client = MagicMock()
    client.post_prompt = AsyncMock()
    client.get_messages = AsyncMock(return_value=[])
    client.request_stop = AsyncMock(return_value=True)
    processor = MagicMock()
    processor.build_file_parts.return_value = []
    result = OpencodeHarness(
        client=client,
        attachment_processor=processor,
        log=MagicMock(),
        limits=PromptLimits(
            inactivity_timeout_seconds=0.02,
            prompt_max_duration_seconds=0.02,
            prompt_cleanup_timeout_seconds=0.02,
        ),
    )
    result.session_id = SESSION_ID
    return result


def set_stream(harness, frames, *, delay_seconds=0, error=None):
    @asynccontextmanager
    async def events(**_kwargs):
        async def iterator() -> AsyncIterator[dict]:
            for frame in frames:
                if delay_seconds:
                    await asyncio.sleep(delay_seconds)
                yield frame
            if error is not None:
                raise error

        yield iterator()

    harness.client.events = events


async def run(harness, sink=None):
    return await harness.run_prompt(
        HarnessPrompt(message_id="cp-msg", text="test"), sink or AsyncMock()
    )


async def test_runtime_path_does_not_restart_stream_owned_whole_turn_budget(harness):
    set_stream(
        harness,
        [assistant(), event("session.idle", sessionID=SESSION_ID)],
        delay_seconds=0.03,
    )

    outcome = await run(harness)

    assert outcome.success
    assert outcome.execution_stopped
    harness.client.request_stop.assert_not_awaited()


async def test_eof_preserves_delivered_text_and_usage_without_claiming_stop(harness):
    set_stream(
        harness,
        [assistant(), part("text", text="Partial output"), part("step-finish", cost=0.25)],
    )
    sink = AsyncMock()

    outcome = await run(harness, sink)

    assert not outcome.success
    assert not outcome.execution_stopped
    assert "disconnected before completion" in outcome.error
    assert outcome.message_cost_usd == 0.25
    assert sink.await_args_list[0].args[0]["content"] == "Partial output"
    harness.client.request_stop.assert_not_awaited()


async def test_stream_error_does_not_start_an_independent_cleanup_allowance(harness):
    set_stream(
        harness, [assistant()], error=SSEInactivityTimeoutError("receive or downstream stall")
    )

    outcome = await run(harness)

    assert not outcome.execution_stopped
    assert outcome.error == "receive or downstream stall"
    harness.client.request_stop.assert_not_awaited()
    harness.client.get_messages.assert_not_awaited()


@pytest.mark.parametrize("pending_kind", ["tool", "child", "grandchild"])
async def test_parent_idle_is_not_cessation_with_unresolved_owned_work(harness, pending_kind):
    frames = [assistant()]
    if pending_kind == "tool":
        frames.append(part("tool", tool="bash", callID="call_1", state={"status": "running"}))
    else:
        frames.append(event("session.created", info={"id": "child", "parentID": SESSION_ID}))
        if pending_kind == "grandchild":
            frames.extend(
                [
                    event("session.created", info={"id": "grandchild", "parentID": "child"}),
                    event("session.idle", sessionID="child"),
                ]
            )
    frames.append(event("session.idle", sessionID=SESSION_ID))
    set_stream(harness, frames)

    outcome = await run(harness)

    assert not outcome.success
    assert not outcome.execution_stopped
    assert await harness.stop(asyncio.get_running_loop().time() + 1) is False
    harness.client.request_stop.assert_awaited_once()


async def test_completed_tool_and_idle_child_allow_reuse(harness):
    set_stream(
        harness,
        [
            assistant(),
            event("session.created", info={"id": "child", "parentID": SESSION_ID}),
            part("tool", tool="bash", callID="call_1", state={"status": "running"}),
            part("tool", tool="bash", callID="call_1", state={"status": "completed"}),
            event("session.idle", sessionID="child"),
            event("session.idle", sessionID=SESSION_ID),
        ],
    )

    outcome = await run(harness)

    assert outcome.success
    assert outcome.execution_stopped
    assert await harness.stop(asyncio.get_running_loop().time() + 1) is True
    harness.client.request_stop.assert_not_awaited()


async def test_error_result_followed_by_idle_is_failed_but_stopped(harness):
    set_stream(
        harness,
        [assistant(error={"name": "Failure"}), event("session.idle", sessionID=SESSION_ID)],
    )

    outcome = await run(harness)

    assert not outcome.success
    assert outcome.error == "Failure"
    assert outcome.execution_stopped


async def test_idle_without_current_turn_activity_is_not_stop_evidence(harness):
    set_stream(
        harness,
        [assistant(parentID="previous_user_message"), event("session.idle", sessionID=SESSION_ID)],
    )

    outcome = await run(harness)

    assert not outcome.success
    assert not outcome.execution_stopped


async def test_session_error_without_idle_is_not_confirmed_stop(harness):
    set_stream(harness, [event("session.error", sessionID=SESSION_ID, error={"name": "Failure"})])

    outcome = await run(harness)

    assert not outcome.execution_stopped
    assert outcome.error == "Failure"


async def test_abort_acknowledgment_alone_is_not_stop_confirmation(harness):
    assert await harness.stop(asyncio.get_running_loop().time() + 1) is False
    harness.client.request_stop.assert_awaited_once()


async def test_stop_uses_remaining_absolute_cleanup_budget(harness):
    async def hanging_abort(*_args, **_kwargs):
        await asyncio.Event().wait()

    harness.client.request_stop.side_effect = hanging_abort
    started = asyncio.get_running_loop().time()

    assert await harness.stop(started + 0.03) is False
    assert asyncio.get_running_loop().time() - started < 0.3


async def test_http_stream_backpressure_is_failure_not_reader_cancellation(harness):
    class EventBytes(httpx.AsyncByteStream):
        async def __aiter__(self):
            for frame in [
                assistant(),
                part("text", text="Partial output"),
                event("server.heartbeat"),
                event("session.idle", sessionID=SESSION_ID),
            ]:
                yield f"data: {json.dumps(frame)}\n\n".encode()
                await asyncio.sleep(0)

    def respond(request):
        if request.url.path == "/event":
            return httpx.Response(200, stream=EventBytes())
        assert request.url.path.endswith("/prompt_async")
        return httpx.Response(204)

    delivered = []

    async def slow_sink(item):
        await asyncio.sleep(0.05)
        delivered.append(item)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as pool:
        harness.client = OpenCodeClient(
            base_url="http://localhost:4096", log=MagicMock(), http_client=pool
        )

        outcome = await run(harness, slow_sink)

    assert delivered[0]["content"] == "Partial output"
    assert not outcome.success
    assert not outcome.execution_stopped
    assert "receive or downstream processing may be stalled" in outcome.error
    assert asyncio.current_task().cancelling() == 0
