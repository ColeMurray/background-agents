"""Spending controls survive duplicate events, child sessions and prompt resets."""

import pytest

from sandbox_runtime.prompt_budget import PromptBudget, PromptBudgetExceeded, PromptLimits


def part(part_id="step1", session="parent", **kwargs):
    return {"id": part_id, "sessionID": session, **kwargs}


def test_counts_once_per_session_part():
    budget = PromptBudget(PromptLimits(turns=3))
    budget.record(part(tokens={"input": 20, "output": 2, "reasoning": 3}))
    budget.record(part(tokens={"input": 20}))
    assert budget.turns == 1
    assert budget.tokens == 25
    budget.record(part(session="child"))
    assert budget.turns == 2
    with pytest.raises(PromptBudgetExceeded, match="turns"):
        budget.record(part("step2"))


def test_cumulative_token_limit_and_fresh_prompt():
    limits = PromptLimits(tokens=30)
    budget = PromptBudget(limits)
    budget.record(part(tokens={"input": 20}))
    with pytest.raises(PromptBudgetExceeded, match="tokens"):
        budget.record(part("step2", tokens={"input": 5, "output": 5}))
    fresh = PromptBudget(limits)
    fresh.record(part(tokens={"input": 20}))
    assert fresh.tokens == 20


def test_cost_cap_and_invalid_usage():
    budget = PromptBudget(PromptLimits(cost_usd=1))
    budget.record(part(cost=float("nan"), tokens={"input": -2, "output": "oops"}))
    assert budget.tokens == 0
    assert budget.cost_usd == 0
    with pytest.raises(PromptBudgetExceeded, match="cost_usd"):
        budget.record(part("step2", cost=1))


def test_zero_disables_guard():
    budget = PromptBudget(PromptLimits(turns=0, tokens=0, cost_usd=0))
    budget.record(part(tokens={"input": 9_000_000}, cost=1000))
    assert budget.tokens == 9_000_000


@pytest.mark.parametrize("invalid", ["oops", "nan", "inf", "-1"])
def test_invalid_environment_keeps_default(monkeypatch, invalid):
    monkeypatch.setenv("BRIDGE_MAX_PROMPT_TURNS", invalid)
    assert PromptLimits.from_env().turns == 80


def test_unrelated_session_does_not_consume_budget(monkeypatch):
    from tests.test_prompt_stream import make_state, make_stream, sse

    monkeypatch.setenv("BRIDGE_MAX_PROMPT_TURNS", "1")
    state = make_state()
    stream = make_stream()
    stream._apply_sse_event(
        state,
        sse(
            "message.part.updated",
            {"part": part(session="unrelated", type="step-finish", messageID="other")},
        ),
    )
    assert state.budget.turns == 0
    state.attribution.allow_assistant("assistant")
    with pytest.raises(PromptBudgetExceeded):
        stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": part(
                        session=state.opencode_session_id, type="step-finish", messageID="assistant"
                    )
                },
            ),
        )


@pytest.mark.asyncio
async def test_stream_aborts_opencode_and_fails_on_budget(monkeypatch):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from tests.test_prompt_stream import make_stream

    monkeypatch.setenv("BRIDGE_MAX_PROMPT_TURNS", "1")
    stream = make_stream()

    @asynccontextmanager
    async def events(**kwargs):
        async def iterator():
            yield {"type": "test"}

        yield iterator()

    def apply(state, event):
        state.budget.record(part())

    async def final_state(state):
        yield {"type": "token", "content": "final state"}

    stream._client.events = events
    stream._client.post_prompt = AsyncMock()
    stream._client.request_stop = AsyncMock()
    stream._apply_sse_event = apply
    stream._fetch_final_message_state = final_state
    emitted = []
    with pytest.raises(RuntimeError, match="turns budget"):
        async for event in stream.stream_prompt(
            opencode_session_id="parent", message_id="message", content="test"
        ):
            emitted.append(event)
    stream._client.request_stop.assert_awaited_once_with("parent", reason="prompt_max_turns")
    assert emitted == [{"type": "token", "content": "final state"}]


def test_fractional_positive_limits_cannot_disable_guard(monkeypatch):
    monkeypatch.setenv("BRIDGE_MAX_PROMPT_TURNS", "0.5")
    monkeypatch.setenv("BRIDGE_MAX_PROMPT_TOKENS", "0.1")
    limits = PromptLimits.from_env()
    assert limits.turns == 1
    assert limits.tokens == 1
