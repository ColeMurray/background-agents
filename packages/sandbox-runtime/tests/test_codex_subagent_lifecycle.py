import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.client import CodexTransportError
from sandbox_runtime.model_prices import ModelPrice

PARENT, TURN, CHILD = "parent-thread", "parent-turn", "child-thread"
PRICE = {"input": 2, "output": 10}


def build(tmp_path):
    client = MagicMock()
    client.running = True
    client.handling_requests = False
    client.open = AsyncMock()
    client.close = AsyncMock(return_value=True)
    client.notify = AsyncMock()
    interrupts = []

    async def request(method, params, **kwargs):
        if method == "thread/start":
            return {"thread": {"id": PARENT}}
        if method == "turn/start":
            return {"turn": {"id": TURN}}
        if method == "turn/interrupt":
            interrupts.append((params["threadId"], params["turnId"]))
            return {}
        return {"account": {"type": "apiKey"}}

    client.request = AsyncMock(side_effect=request)
    queue = asyncio.Queue()
    client.next_notification = AsyncMock(side_effect=queue.get)
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "native", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=MagicMock(return_value=client),
        environ={"OPENAI_API_KEY": "fixture"},
    )
    return harness, client, queue, interrupts


def spawned(agent=CHILD, *, thread=PARENT, turn=TURN):
    return {
        "method": "item/completed",
        "params": {
            "threadId": thread,
            "turnId": turn,
            "item": {
                "type": "subAgentActivity",
                "id": f"spawn-{agent}",
                "kind": "started",
                "agentThreadId": agent,
                "agentPath": f"/root/{agent}",
            },
        },
    }


def started(thread, turn):
    return {
        "method": "turn/started",
        "params": {"threadId": thread, "turn": {"id": turn, "rootTurnId": TURN}},
    }


def completed(thread, turn, status="completed"):
    return {
        "method": "turn/completed",
        "params": {"threadId": thread, "turn": {"id": turn, "status": status}},
    }


async def run(harness, events):
    async def emit(event):
        events.append(event)

    return await harness.run_prompt(HarnessPrompt("m", "delegate"), emit)


async def test_prompt_settles_only_after_its_subagents_finish(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    events = []
    prompt = asyncio.create_task(run(harness, events))
    for frame in (spawned(), started(CHILD, "child-turn"), completed(PARENT, TURN)):
        queue.put_nowait(frame)
    await asyncio.sleep(0.05)
    assert not prompt.done()
    queue.put_nowait(completed(CHILD, "child-turn"))
    outcome = await asyncio.wait_for(prompt, 5)
    assert outcome.success
    assert interrupts == []
    task = [e for e in events if e.get("tool") == "task"][-1]
    assert task["status"] == "completed"
    # The parent's own step is reported last, as before.
    assert events[-1]["type"] == "step_finish" and "isSubtask" not in events[-1]


async def test_parent_that_does_not_complete_interrupts_running_subagents(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        completed(PARENT, TURN, "interrupted"),
    ):
        queue.put_nowait(frame)
    prompt = asyncio.create_task(run(harness, []))
    await asyncio.sleep(0.05)
    assert interrupts == [(CHILD, "child-turn")]
    queue.put_nowait(completed(CHILD, "child-turn", "interrupted"))
    outcome = await asyncio.wait_for(prompt, 5)
    assert outcome.cancelled


async def test_grandchild_turn_is_interrupted_as_soon_as_it_starts(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        spawned("grandchild", thread=CHILD, turn="child-turn"),
        started("grandchild", "grand-turn"),
        completed("grandchild", "grand-turn", "interrupted"),
        completed(CHILD, "child-turn"),
        completed(PARENT, TURN),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(run(harness, []), 5)).success
    assert interrupts == [("grandchild", "grand-turn")]


async def test_prompt_waits_for_refused_grandchild_start_after_parent_completion(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        spawned("grandchild", thread=CHILD, turn="child-turn"),
        completed(CHILD, "child-turn"),
        completed(PARENT, TURN),
        started("grandchild", "grand-turn"),
        completed("grandchild", "grand-turn", "interrupted"),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(run(harness, []), 5)).success
    assert interrupts == [("grandchild", "grand-turn")]
    assert queue.empty()


@pytest.mark.parametrize("grandchild_started", [False, True])
async def test_unsettled_refused_grandchild_is_contained_on_timeout(tmp_path, grandchild_started):
    harness, client, queue, interrupts = build(tmp_path)
    harness.limits = PromptLimits(0.05, 30, 5)
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        spawned("grandchild", thread=CHILD, turn="child-turn"),
        completed(CHILD, "child-turn"),
        completed(PARENT, TURN),
    ):
        queue.put_nowait(frame)
    if grandchild_started:
        queue.put_nowait(started("grandchild", "grand-turn"))
    outcome = await asyncio.wait_for(run(harness, []), 5)
    assert not outcome.success
    assert "no output" in outcome.error
    assert interrupts == ([("grandchild", "grand-turn")] if grandchild_started else [])
    client.close.assert_awaited_once()
    assert queue.empty()
    assert harness._subagents is None


async def test_subagent_tool_call_waits_for_its_turn_to_be_projected(tmp_path):
    harness, _, queue, _ = build(tmp_path)
    harness._tools = MagicMock(
        call=AsyncMock(return_value={"success": True}), catalog_hash="fixture"
    )
    queue.put_nowait(spawned())
    prompt = asyncio.create_task(run(harness, []))
    await asyncio.sleep(0.05)
    params = {"threadId": CHILD, "turnId": "child-turn", "namespace": "oi", "tool": "t"}
    # The call overtakes the queued notification that starts the sub-agent's turn.
    call = asyncio.create_task(harness._server_request("item/tool/call", params))
    await asyncio.sleep(0.05)
    assert not call.done()
    queue.put_nowait(started(CHILD, "child-turn"))
    assert await asyncio.wait_for(call, 5) == {"success": True}
    harness._tools.call.assert_awaited_once_with(params)

    # A thread that is not a running sub-agent of this prompt is refused.
    stranger = {**params, "threadId": "stranger"}
    with pytest.raises(RuntimeError, match="not owned"):
        async with asyncio.timeout(5):
            stranger_call = asyncio.create_task(harness._server_request("item/tool/call", stranger))
            await asyncio.sleep(0.05)
            for frame in (completed(CHILD, "child-turn"), completed(PARENT, TURN)):
                queue.put_nowait(frame)
            await stranger_call
    assert (await asyncio.wait_for(prompt, 5)).success


async def test_abort_interrupts_the_parent_and_its_running_subagents(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    for frame in (spawned(), started(CHILD, "child-turn")):
        queue.put_nowait(frame)
    prompt = asyncio.create_task(run(harness, []))
    await asyncio.sleep(0.05)
    assert await harness.abort()
    assert interrupts == [(PARENT, TURN), (CHILD, "child-turn")]
    for frame in (
        completed(CHILD, "child-turn", "interrupted"),
        completed(PARENT, TURN, "interrupted"),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(prompt, 5)).cancelled


async def test_abnormal_exit_releases_the_prompts_subagents(tmp_path):
    harness, _, queue, _ = build(tmp_path)

    async def failing_emit(event):
        if event.get("tool") == "task":
            raise RuntimeError("sink failed")

    queue.put_nowait(spawned())
    with pytest.raises(RuntimeError, match="sink failed"):
        await harness.run_prompt(HarnessPrompt("m", "delegate"), failing_emit)
    assert harness._subagents is None


async def test_child_spawning_before_its_announcement_is_still_limited(tmp_path):
    harness, _, queue, interrupts = build(tmp_path)
    for frame in (
        started(CHILD, "child-turn"),
        spawned("grandchild", thread=CHILD, turn="child-turn"),
        started("grandchild", "grand-turn"),
        spawned(),
        completed("grandchild", "grand-turn", "interrupted"),
        completed(CHILD, "child-turn"),
        completed(PARENT, TURN),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(run(harness, []), 5)).success
    assert interrupts == [("grandchild", "grand-turn")]


async def test_subagent_finished_before_its_announcement_settles(tmp_path):
    harness, _, queue, _ = build(tmp_path)
    events = []
    for frame in (
        started(CHILD, "child-turn"),
        completed(CHILD, "child-turn"),
        spawned(),
        completed(PARENT, TURN),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(run(harness, events), 5)).success
    assert [e for e in events if e.get("tool") == "task"][-1]["status"] == "completed"


def usage(thread, turn, input_tokens, output_tokens):
    counts = {
        "inputTokens": input_tokens,
        "cachedInputTokens": 0,
        "outputTokens": output_tokens,
        "reasoningOutputTokens": 0,
        "totalTokens": input_tokens + output_tokens,
    }
    return {
        "method": "thread/tokenUsage/updated",
        "params": {"threadId": thread, "turnId": turn, "tokenUsage": {"total": counts}},
    }


async def test_subagent_spend_counts_toward_the_prompts_cost(tmp_path):
    harness, _, queue, _ = build(tmp_path)
    # USD per million tokens.
    harness._prices = MagicMock(price=MagicMock(return_value=ModelPrice.parse(PRICE)))
    events = []
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        usage(CHILD, "child-turn", 1000, 100),
        completed(CHILD, "child-turn"),
        usage(PARENT, TURN, 500, 50),
        completed(PARENT, TURN),
    ):
        queue.put_nowait(frame)
    outcome = await asyncio.wait_for(run(harness, events), 5)
    assert outcome.success
    steps = [e for e in events if e["type"] == "step_finish"]
    child = [e for e in steps if e.get("isSubtask")][-1]
    parent = steps[-1]
    # 1000 input at $2/M and 100 output at $10/M; then 500 and 50 for the parent.
    assert child["cost"] == 0.003 and child["messageCostUsd"] == 0.003
    assert parent["cost"] == 0.0015 and parent["messageCostUsd"] == 0.0045
    assert outcome.message_cost_usd == 0.0045
    assert not [e for e in events if e["type"] == "warning"]


async def test_parent_tool_call_waits_for_the_turn_to_be_known(tmp_path):
    harness, client, queue, _ = build(tmp_path)
    harness._tools = MagicMock(
        call=AsyncMock(return_value={"success": True}), catalog_hash="fixture"
    )
    turn_started = asyncio.Event()
    request = client.request.side_effect

    async def slow_turn_start(method, params, **kwargs):
        if method == "turn/start":
            await turn_started.wait()
        return await request(method, params, **kwargs)

    client.request.side_effect = slow_turn_start
    prompt = asyncio.create_task(run(harness, []))
    await asyncio.sleep(0.05)
    params = {"threadId": PARENT, "turnId": TURN, "namespace": "oi", "tool": "t"}
    # The call overtakes the turn/start response that identifies its turn.
    call = asyncio.create_task(harness._server_request("item/tool/call", params))
    await asyncio.sleep(0.05)
    assert not call.done()
    turn_started.set()
    assert await asyncio.wait_for(call, 5) == {"success": True}

    with pytest.raises(RuntimeError, match="not owned"):
        await asyncio.wait_for(
            harness._server_request("item/tool/call", {**params, "turnId": "older-turn"}), 5
        )
    queue.put_nowait(completed(PARENT, TURN))
    assert (await asyncio.wait_for(prompt, 5)).success
    # Between prompts, nothing owns a tool call.
    with pytest.raises(RuntimeError, match="not owned"):
        await asyncio.wait_for(harness._server_request("item/tool/call", params), 5)


async def test_an_uncertain_interrupt_does_not_skip_the_rest(tmp_path):
    harness, client, queue, interrupts = build(tmp_path)
    request = client.request.side_effect

    async def first_interrupt_times_out(method, params, **kwargs):
        if method == "turn/interrupt" and not interrupts:
            interrupts.append((params["threadId"], params["turnId"]))
            raise CodexTransportError("Codex turn/interrupt response timed out")
        return await request(method, params, **kwargs)

    client.request.side_effect = first_interrupt_times_out
    for frame in (
        spawned(),
        started(CHILD, "child-turn"),
        spawned("second"),
        started("second", "second-turn"),
        completed(PARENT, TURN, "interrupted"),
        completed(CHILD, "child-turn", "interrupted"),
        completed("second", "second-turn", "interrupted"),
    ):
        queue.put_nowait(frame)
    assert (await asyncio.wait_for(run(harness, []), 5)).cancelled
    assert interrupts == [(CHILD, "child-turn"), ("second", "second-turn")]
