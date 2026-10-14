import json

import pytest

from sandbox_runtime.harness.codex.events import CodexTurnEvents


@pytest.mark.parametrize("method", ["item/started", "item/completed"])
@pytest.mark.parametrize(
    "action,summary,tool,args",
    [
        (
            {
                "type": "openPage",
                "url": "https://github.com/ColeMurray/background-agents/pull/2134",
            },
            "https://github.com/ColeMurray/background-agents/pull/2134",
            "webfetch",
            {"url": "https://github.com/ColeMurray/background-agents/pull/2134"},
        ),
        (
            {"type": "findInPage", "url": "https://example.com", "pattern": "release"},
            "'release' in https://example.com",
            "webfetch",
            {"url": "https://example.com", "pattern": "release"},
        ),
        (
            {"type": "search", "query": "Codex MCP", "queries": None},
            "Codex MCP",
            "websearch",
            {"query": "Codex MCP"},
        ),
        (
            {"type": "search", "query": None, "queries": ["first query", "second query"]},
            "first query ...",
            "websearch",
            {"query": "first query ...", "queries": ["first query", "second query"]},
        ),
        (None, "", "websearch", {"query": ""}),
        ({"type": "other"}, "unknown action", "websearch", {"query": "unknown action"}),
    ],
)
def test_web_actions_use_display_tool_and_arguments(method, action, summary, tool, args):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    event = state.accept(
        {
            "method": method,
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "item": {"type": "webSearch", "id": "web", "query": summary, "action": action},
            },
        }
    )[0]
    assert event["tool"] == tool
    assert event["args"] == args
    assert event["callId"] == "codex:turn:web"
    assert event["status"] == ("running" if method == "item/started" else "completed")


def test_long_text_is_coalesced_and_final_projection_fits_transport(monkeypatch):
    from sandbox_runtime.event_size import MAX_EVENT_BYTES, event_size_bytes

    now = 0.0
    monkeypatch.setattr("sandbox_runtime.harness.codex.events.time.monotonic", lambda: now)
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    events = []
    # Escaped controls and non-BMP Unicode exercise JSON's worst-case expansion.
    chunk = '\U0001f642"\\\n' * 256
    for _ in range(1024):
        now += 0.001
        events.extend(
            state.accept(
                {
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thread",
                        "turnId": "turn",
                        "itemId": "a",
                        "delta": chunk,
                    },
                }
            )
        )
    events.extend(
        state.accept(
            {
                "method": "turn/completed",
                "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}},
            }
        )
    )
    assert len(events) < 20
    assert all(event_size_bytes(event) < MAX_EVENT_BYTES for event in events)
    assert events[-1]["content"].startswith(chunk)
    assert "remaining text omitted" in events[-1]["content"]
    # A million input characters must not cause a million-character retained buffer.
    assert len(json.dumps(state.text)) < MAX_EVENT_BYTES


def test_turn_completion_flushes_coalesced_text_and_preserves_item_order(monkeypatch):
    monkeypatch.setattr("sandbox_runtime.harness.codex.events.time.monotonic", lambda: 0.0)
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})

    def event(method, **params):
        return state.accept(
            {"method": method, "params": {"threadId": "thread", "turnId": "turn", **params}}
        )

    assert event("item/agentMessage/delta", itemId="a", delta="first")
    assert event("item/agentMessage/delta", itemId="a", delta=" answer") == []
    assert event("item/agentMessage/delta", itemId="b", delta="second") == []
    assert event("turn/completed", turn={"id": "turn", "status": "completed"}) == [
        {"type": "token", "messageId": "m", "content": "first answer\n\nsecond"}
    ]


def test_turn_text_repair_and_child_completion_are_isolated():
    state = CodexTurnEvents("message", "thread", "turn", "gpt-6.1-sol", {})

    def event(method, **params):
        return state.accept(
            {"method": method, "params": {"threadId": "thread", "turnId": "turn", **params}}
        )

    assert event("item/agentMessage/delta", itemId="a", delta="hel")[0]["content"] == "hel"
    assert (
        event("item/completed", item={"type": "agentMessage", "id": "a", "text": "hello"})[0][
            "content"
        ]
        == "hello"
    )
    assert event("item/completed", item={"type": "agentMessage", "id": "a", "text": "hello"}) == []
    state.accept(
        {
            "method": "turn/completed",
            "params": {"threadId": "child", "turn": {"id": "turn", "status": "completed"}},
        }
    )
    assert state.status is None
    event("turn/completed", turn={"id": "turn", "status": "completed"})
    assert state.status == "completed"


def test_usage_charges_only_this_turn_and_counts_cache_and_reasoning_once():
    prior = {
        "inputTokens": 1000,
        "cachedInputTokens": 500,
        "outputTokens": 100,
        "reasoningOutputTokens": 50,
        "totalTokens": 1100,
    }
    state = CodexTurnEvents("m2", "thread", "turn2", "gpt-6.1-sol", prior)
    total = {
        "inputTokens": 2000,
        "cachedInputTokens": 1000,
        "outputTokens": 200,
        "reasoningOutputTokens": 100,
        "totalTokens": 2200,
    }
    frame = {
        "method": "thread/tokenUsage/updated",
        "params": {"threadId": "thread", "turnId": "turn2", "tokenUsage": {"total": total}},
    }
    projected = state.accept(frame)[0]
    assert projected["tokens"]["total"] == 1100
    assert projected["tokens"]["input"] == 500
    assert projected["tokens"]["output"] == 50
    assert projected["tokens"]["reasoning"] == 50
    assert projected["messageCostUsd"] == 0
    state.accept(frame)
    assert state.finish()["cost"] == 0


def usage(state, total):
    return state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": state.thread_id,
                "turnId": state.turn_id,
                "tokenUsage": {"total": total},
            },
        }
    )[0]


def counts(input_tokens):
    return {
        "inputTokens": input_tokens,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "reasoningOutputTokens": 0,
        "totalTokens": input_tokens,
    }


def test_unknown_cancelled_baseline_does_not_attribute_previous_turn_tokens():
    state = CodexTurnEvents(
        "m2", "thread", "turn2", "gpt-6.1-sol", counts(100), baseline_known=False
    )
    # The native history includes 50 previously unobserved tokens, then this turn's 10.
    projected = usage(state, counts(160))
    assert projected["cost"] == 0
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert state.has_usage
    assert state.total["inputTokens"] == 160

    following = CodexTurnEvents("m3", "thread", "turn3", "gpt-6.1-sol", state.total)
    projected = usage(following, counts(170))
    assert projected["tokens"]["input"] == 10
    assert projected["cost"] == 0
    assert following.has_usage


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        {},
        {**counts(100), "inputTokens": True},
        {**counts(100), "inputTokens": "100"},
        {**counts(100), "outputTokens": 1.5},
        {**counts(100), "cachedInputTokens": -1},
        {**counts(100), "cacheWriteInputTokens": True},
        {**counts(100), "cachedInputTokens": 101},
        {**counts(100), "cachedInputTokens": 90, "cacheWriteInputTokens": 11},
        {**counts(100), "reasoningOutputTokens": 1},
        {**counts(100), "totalTokens": 99},
        counts(2**53),
    ],
)
def test_malformed_usage_does_not_invent_tokens(invalid):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    assert usage(state, counts(50))["cost"] == 0
    projected = usage(state, invalid)
    assert projected["cost"] == 0
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert not state.has_usage
    assert state.total["inputTokens"] == 50
    # A later clean frame cannot retroactively make this malformed series trustworthy.
    assert usage(state, counts(200))["cost"] == 0
    assert not state.has_usage


def test_absolute_valid_but_overlapping_delta_cannot_be_attributed():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100))
    assert usage(state, {**counts(100), "cachedInputTokens": 1})["cost"] == 0
    assert not state.has_usage


def test_unknown_baseline_tracks_valid_totals_without_using_unsafe_deltas():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100), baseline_known=False)
    assert usage(state, {**counts(160), "cachedInputTokens": 150})["cost"] == 0
    assert state.has_usage
    assert state.total["cachedInputTokens"] == 150


def test_no_usage_and_nonmonotonic_series_cannot_establish_a_safe_baseline():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    assert not state.has_usage
    usage(state, counts(100))
    assert usage(state, counts(99))["cost"] == 0
    assert not state.has_usage


@pytest.mark.parametrize("envelope", [None, [], "invalid"])
def test_malformed_usage_envelope_does_not_throw(envelope):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    projected = state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {"threadId": "thread", "turnId": "turn", "tokenUsage": envelope},
        }
    )[0]
    assert "costAvailability" not in projected
    assert not state.has_usage


def test_zero_usage_is_authoritative_and_cost_is_zero_for_unknown_models():
    state = CodexTurnEvents("m", "thread", "turn", "unknown-model", {})
    projected = usage(state, counts(0))
    assert state.has_usage
    assert projected["tokens"]["total"] == 0
    assert projected["cost"] == 0
    assert "costAvailability" not in projected


def test_invalid_restored_baseline_can_recover_authoritative_totals():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {"inputTokens": True})
    assert usage(state, counts(10))["cost"] == 0
    assert state.has_usage
    assert state.total["inputTokens"] == 10
