import json

import pytest

from sandbox_runtime.harness.codex.events import CodexTurnEvents
from sandbox_runtime.model_prices import ModelPrice

# gpt-6.1-sol in the models.dev catalog: USD per million tokens.
PRICE = ModelPrice.parse(
    {
        "input": 2,
        "output": 10,
        "cache_read": 0.1,
        "cache_write": 2.5,
        "tiers": [
            {
                "input": 4,
                "output": 15,
                "cache_read": 0.2,
                "cache_write": 5,
                "tier": {"type": "context", "size": 272000},
            }
        ],
        "context_over_200k": {"input": 4, "output": 15, "cache_read": 0.2, "cache_write": 5},
    }
)


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
    state = CodexTurnEvents("m2", "thread", "turn2", "gpt-6.1-sol", prior, price=PRICE)
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
    assert projected["tokens"]["cache"]["read"] == 500
    # 500 input at $2/M, 50 output and 50 reasoning at $10/M, 500 cache reads at $0.1/M.
    assert projected["cost"] == projected["messageCostUsd"] == 0.00205
    # A repeated total adds no usage and no cost.
    state.accept(frame)
    assert state.finish()["cost"] == state.finish()["messageCostUsd"] == 0.00205


def usage(state, total, last=None):
    token_usage = {"total": total, **({"last": last} if last is not None else {})}
    return state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": state.thread_id,
                "turnId": state.turn_id,
                "tokenUsage": token_usage,
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
        "m2", "thread", "turn2", "gpt-6.1-sol", counts(100), baseline_known=False, price=PRICE
    )
    # The native history includes 50 previously unobserved tokens, then this turn's 10.
    projected = usage(state, counts(160))
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert state.has_usage
    assert state.total["inputTokens"] == 160

    following = CodexTurnEvents("m3", "thread", "turn3", "gpt-6.1-sol", state.total, price=PRICE)
    projected = usage(following, counts(170))
    assert projected["tokens"]["input"] == 10
    assert projected["cost"] == projected["messageCostUsd"] == 0.00002
    assert following.has_usage


def test_unknown_baseline_attributes_each_request_from_its_own_usage():
    state = CodexTurnEvents(
        "m2", "thread", "turn2", "gpt-6.1-sol", counts(100), baseline_known=False, price=PRICE
    )
    # 50 unobserved tokens of earlier native history, then this turn's two requests.
    usage(state, counts(160), last=counts(10))
    # A repeated total is not a new request.
    usage(state, counts(160), last=counts(10))
    projected = usage(state, counts(190), last=counts(30))
    assert projected["tokens"]["input"] == 40
    assert projected["cost"] == projected["messageCostUsd"] == 0.00008
    assert state.attribution_complete


@pytest.mark.parametrize("last", [None, counts(61), {"inputTokens": True}])
def test_unknown_baseline_without_separable_request_usage_stops_attributing(last):
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", counts(100), baseline_known=False, price=PRICE
    )
    assert usage(state, counts(110), last=counts(10))["cost"] == 0.00002
    projected = usage(state, counts(170), last=last)
    assert not state.attribution_complete
    assert "cost" not in projected
    assert "tokens" not in projected
    # Later requests are not attributed either: the turn's usage is no longer whole.
    projected = usage(state, counts(180), last=counts(10))
    assert "tokens" not in projected
    assert projected["messageCostUsd"] == 0.00002
    assert state.total["inputTokens"] == 180


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
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE)
    assert usage(state, counts(50))["cost"] == 0.0001
    projected = usage(state, invalid)
    # The turn is no longer fully priced; what was priced before still counts.
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0.0001
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert not state.has_usage
    assert state.total["inputTokens"] == 50
    # A later clean frame cannot retroactively make this malformed series trustworthy.
    projected = usage(state, counts(200))
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0.0001
    assert not state.has_usage


def test_absolute_valid_but_overlapping_delta_cannot_be_attributed():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100), price=PRICE)
    projected = usage(state, {**counts(100), "cachedInputTokens": 1})
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert not state.has_usage


def test_request_delta_that_breaks_token_invariants_is_not_priced():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE)
    assert usage(state, counts(100))["cost"] == 0.0002
    # Both totals are valid, and so is the turn's, but this request's 150 cached
    # tokens exceed its 100 input tokens.
    projected = usage(state, {**counts(200), "cachedInputTokens": 150})
    assert not state.usage_valid
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0.0002


def test_unknown_baseline_tracks_valid_totals_without_using_unsafe_deltas():
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", counts(100), baseline_known=False, price=PRICE
    )
    projected = usage(state, {**counts(160), "cachedInputTokens": 150})
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert state.has_usage
    assert state.total["cachedInputTokens"] == 150


def test_no_usage_and_nonmonotonic_series_cannot_establish_a_safe_baseline():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE)
    assert not state.has_usage
    # Nothing reported yet is nothing spent.
    assert state.finish()["cost"] == 0
    usage(state, counts(100))
    assert "cost" not in usage(state, counts(99))
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


def test_zero_usage_is_authoritative_and_unpriced_models_omit_cost():
    state = CodexTurnEvents("m", "thread", "turn", "unknown-model", {})
    projected = usage(state, counts(0))
    assert state.has_usage
    assert projected["tokens"]["total"] == 0
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert "costAvailability" not in projected


def test_invalid_restored_baseline_can_recover_authoritative_totals():
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {"inputTokens": True}, price=PRICE
    )
    # The totals recover; a turn with no trusted baseline is still not billed.
    assert "cost" not in usage(state, counts(10))
    assert state.has_usage
    assert state.total["inputTokens"] == 10


def breakdown(input_tokens, cached, write, output, reasoning):
    return {
        "inputTokens": input_tokens,
        "cachedInputTokens": cached,
        "cacheWriteInputTokens": write,
        "outputTokens": output,
        "reasoningOutputTokens": reasoning,
        "totalTokens": input_tokens + output,
    }


def add(left, right):
    return {key: left[key] + right[key] for key in left}


def test_each_request_is_priced_at_the_rate_for_its_own_context():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE)
    requests = [
        breakdown(48_000, 40_000, 6_000, 1_200, 800),
        breakdown(52_000, 46_000, 0, 2_500, 1_500),
        # Over 200k but under the 272k tier: OpenCode's context_over_200k rates.
        breakdown(230_000, 50_000, 0, 800, 300),
    ]
    total = breakdown(0, 0, 0, 0, 0)
    reported = []
    for request in requests:
        total = add(total, request)
        reported.append(usage(state, total, last=request)["messageCostUsd"])
    # $0.035 + $0.0416 + $0.742. Pricing the summed 330k input at the tier
    # rate instead would report $0.8767.
    assert reported == [0.035, 0.0766, 0.8186]
    assert state.finish()["cost"] == 0.8186
    assert state.tokens == {
        "input": 188_000,
        "output": 1_900,
        "reasoning": 2_600,
        "cache": {"read": 136_000, "write": 6_000},
        "total": 334_500,
    }


def test_request_without_last_usage_selects_its_rate_from_the_delta():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100_000), price=PRICE)
    # The delta (172,001 input) stays at base rates, although the thread total exceeds 272k.
    assert usage(state, counts(272_001))["cost"] == 0.344002


def test_usage_for_several_requests_in_one_update_is_an_estimate():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE)
    # The total advanced by 220k input, but the update reports a 10k request:
    # the 210k request before it was never reported on its own.
    projected = usage(state, counts(220_000), last=counts(10_000))
    assert not state.requests_separable
    assert "cost" not in projected
    # Priced as one 220k request, at the over-200k rate, never at the 10k request's.
    assert projected["messageCostUsd"] == 0.88
    assert projected["tokens"]["input"] == 220_000


def _turn():
    return CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})


def _frame(method, **params):
    return {"method": method, "params": {"threadId": "thread", "turnId": "turn", **params}}


def _item(method, item):
    return _frame(method, item=item)


def test_compaction_is_one_boundary_between_text_segments(monkeypatch):
    # A fixed clock keeps the second delta inside the throttle window.
    monkeypatch.setattr("sandbox_runtime.harness.codex.events.time.monotonic", lambda: 0.0)
    turn = _turn()
    events = turn.accept(_frame("item/agentMessage/delta", itemId="a", delta="Before"))
    # A throttled delta is still pending when compaction starts.
    events += turn.accept(_frame("item/agentMessage/delta", itemId="a", delta=" more"))
    events += turn.accept(_item("item/started", {"type": "contextCompaction", "id": "c"}))
    events += turn.accept(_item("item/completed", {"type": "contextCompaction", "id": "c"}))
    events += turn.accept(
        _item("item/completed", {"type": "agentMessage", "id": "b", "text": "After"})
    )
    assert [(e["type"], e.get("content")) for e in events] == [
        ("token", "Before"),
        ("token", "Before more"),
        ("context_compacted", None),
        ("token", "After"),
    ]


def test_dynamic_tool_output_is_the_tool_text_not_the_native_envelope():
    envelope = json.dumps({"number": 7, "url": "https://example.com/pull/7"})
    item = {
        "type": "dynamicToolCall",
        "id": "t",
        "tool": "create-pull-request",
        "status": "completed",
        "contentItems": [{"type": "inputText", "text": envelope}],
    }
    [event] = _turn().accept(_item("item/completed", item))
    assert event["output"] == envelope


def test_mcp_tool_output_extracts_text_and_keeps_error_messages():
    ok = {
        "type": "mcpToolCall",
        "id": "ok",
        "server": "linear",
        "tool": "get_issue",
        "status": "completed",
        "result": {"content": [{"type": "text", "text": "issue body"}]},
    }
    failed = {
        "type": "mcpToolCall",
        "id": "bad",
        "server": "linear",
        "tool": "get_issue",
        "status": "failed",
        "error": {"message": "not found"},
    }
    turn = _turn()
    [success] = turn.accept(_item("item/completed", ok))
    [failure] = turn.accept(_item("item/completed", failed))
    assert success["output"] == "issue body"
    assert (failure["status"], failure["output"]) == ("error", "not found")


def test_large_tool_arguments_are_left_to_the_event_forwarder():
    changes = [{"path": f"src/file_{i}.py", "diff": "+" * 1024} for i in range(70)]
    item = {"type": "fileChange", "id": "f", "status": "completed", "changes": changes}
    [event] = _turn().accept(_item("item/completed", item))
    assert event["args"]["changes"] == changes


@pytest.mark.parametrize(
    "params",
    [
        None,
        "bad",
        {"threadId": "thread", "turn": None},
        {"threadId": "thread", "turnId": "turn", "item": None},
    ],
)
def test_malformed_native_fields_are_ignored(params):
    assert _turn().accept({"method": "item/completed", "params": params}) == []
