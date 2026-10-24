import json

import pytest

from sandbox_runtime.harness.codex.events import CodexRateLimits, CodexTurnEvents
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
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())
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
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())
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
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())

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
    state = CodexTurnEvents(
        "message", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits()
    )

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
    state = CodexTurnEvents(
        "m2", "thread", "turn2", "gpt-6.1-sol", prior, price=PRICE, rate_limits=CodexRateLimits()
    )
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
    )[-1]


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
        "m2",
        "thread",
        "turn2",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    # The native history includes 50 previously unobserved tokens, then this turn's 10.
    projected = usage(state, counts(160))
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert state.has_usage
    assert state.total["inputTokens"] == 160

    following = CodexTurnEvents(
        "m3",
        "thread",
        "turn3",
        "gpt-6.1-sol",
        state.total,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    projected = usage(following, counts(170))
    assert projected["tokens"]["input"] == 10
    assert projected["cost"] == projected["messageCostUsd"] == 0.00002
    assert following.has_usage


def test_unknown_baseline_attributes_each_request_from_its_own_usage():
    state = CodexTurnEvents(
        "m2",
        "thread",
        "turn2",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    # 50 unobserved tokens of earlier native history, then this turn's two requests.
    usage(state, counts(160), last=counts(10))
    # A repeated total is not a new request.
    usage(state, counts(160), last=counts(10))
    projected = usage(state, counts(190), last=counts(30))
    assert projected["tokens"]["input"] == 40
    assert projected["cost"] == projected["messageCostUsd"] == 0.00008
    assert state.attribution_complete


def test_untrusted_checkpoint_is_settled_by_the_first_observed_total():
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    assert usage(state, counts(110), last=counts(10))["cost"] == 0.00002
    # Later advances are this turn's own usage, with or without `last`.
    usage(state, counts(170))
    projected = usage(state, counts(180), last=counts(10))
    assert projected["tokens"]["input"] == 80
    assert projected["cost"] == projected["messageCostUsd"] == 0.00016


@pytest.mark.parametrize("last", [None, counts(61), {"inputTokens": True}])
def test_unattributable_first_request_leaves_later_requests_counted(last):
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    # 60 tokens, some of which may be earlier native history.
    events = state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "tokenUsage": {"total": counts(160), "last": last},
            },
        }
    )
    [warning] = [event for event in events if event["type"] == "warning"]
    assert warning["message"].startswith("Some of this turn's Codex usage")
    assert "tokens" not in events[-1]
    usage(state, counts(170), last=counts(10))
    projected = usage(state, counts(180))
    assert not state.attribution_complete
    # Usage the turn could attribute still counts; the gap keeps `cost` absent.
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0.00004
    assert projected["tokens"]["input"] == 20


@pytest.mark.parametrize(
    ("last", "exact"),
    [(None, True), (counts(100), True), ({"inputTokens": True}, False), ("bad", False)],
)
def test_malformed_request_report_makes_the_cost_an_estimate(last, exact):
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    total = {"total": counts(100), **({"last": last} if last is not None else {})}
    events = state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {"threadId": "thread", "turnId": "turn", "tokenUsage": total},
        }
    )
    # Absent and matching reports price exactly; a supplied but malformed one
    # cannot show the advance is a single request.
    assert ("cost" in events[-1]) is exact
    assert events[-1]["messageCostUsd"] == 0.0002
    assert state.requests_separable is exact
    assert any(event["type"] == "warning" for event in events) is not exact


@pytest.mark.parametrize(("to_model", "exact"), [("gpt-6.1-mini", False), ("gpt-6.1-sol", True)])
def test_rerouted_turn_cost_is_an_estimate_at_the_requested_model_prices(to_model, exact):
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    events = state.accept(
        _frame("model/rerouted", fromModel="gpt-6.1-sol", toModel=to_model, reason="other")
    )
    estimate = [e for e in events if e["message"].startswith("Codex switched models")]
    assert len(estimate) == (0 if exact else 1)
    projected = usage(state, counts(100), last=counts(100))
    assert ("cost" in projected) is exact
    assert projected["messageCostUsd"] == 0.0002


def test_replayed_report_is_a_no_op():
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    first = usage(state, counts(100), last=counts(100))
    events = state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "tokenUsage": {"total": counts(100), "last": counts(100)},
            },
        }
    )
    assert [event["type"] for event in events] == ["step_finish"]
    assert first["cost"] == events[-1]["cost"] == 0.0002
    assert state.requests_separable


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
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
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
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        counts(100),
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    projected = usage(state, {**counts(100), "cachedInputTokens": 1})
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert not state.has_usage


def test_request_delta_that_breaks_token_invariants_is_not_priced():
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    assert usage(state, counts(100))["cost"] == 0.0002
    # Both totals are valid, and so is the turn's, but this request's 150 cached
    # tokens exceed its 100 input tokens.
    projected = usage(state, {**counts(200), "cachedInputTokens": 150})
    assert not state.usage_valid
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0.0002


def test_unknown_baseline_tracks_valid_totals_without_using_unsafe_deltas():
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    projected = usage(state, {**counts(160), "cachedInputTokens": 150})
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert state.has_usage
    assert state.total["cachedInputTokens"] == 150


def test_no_usage_and_nonmonotonic_series_cannot_establish_a_safe_baseline():
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    assert not state.has_usage
    # Nothing reported yet is nothing spent.
    assert state.finish()["cost"] == 0
    usage(state, counts(100))
    assert "cost" not in usage(state, counts(99))
    assert not state.has_usage


@pytest.mark.parametrize("envelope", [None, [], "invalid"])
def test_malformed_usage_envelope_does_not_throw(envelope):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())
    projected = state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {"threadId": "thread", "turnId": "turn", "tokenUsage": envelope},
        }
    )[0]
    assert "costAvailability" not in projected
    assert not state.has_usage


def test_zero_usage_is_authoritative_and_unpriced_models_omit_cost():
    state = CodexTurnEvents(
        "m", "thread", "turn", "unknown-model", {}, rate_limits=CodexRateLimits()
    )
    projected = usage(state, counts(0))
    assert state.has_usage
    assert projected["tokens"]["total"] == 0
    assert "cost" not in projected
    assert projected["messageCostUsd"] == 0
    assert "costAvailability" not in projected


def test_invalid_restored_baseline_can_recover_authoritative_totals():
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        {"inputTokens": True},
        price=PRICE,
        rate_limits=CodexRateLimits(),
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
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    requests = [
        breakdown(48_000, 40_000, 6_000, 1_200, 800),
        breakdown(52_000, 46_000, 0, 2_500, 1_500),
        # Over 200k but below the published 272k tier: still base rates.
        breakdown(230_000, 50_000, 0, 800, 300),
    ]
    total = breakdown(0, 0, 0, 0, 0)
    reported = []
    for request in requests:
        total = add(total, request)
        reported.append(usage(state, total, last=request)["messageCostUsd"])
    # $0.035 + $0.0416 + $0.373. Pricing the summed 330k input at the tier
    # rate instead would report $0.8767.
    assert reported == [0.035, 0.0766, 0.4496]
    assert state.finish()["cost"] == 0.4496
    assert state.tokens == {
        "input": 188_000,
        "output": 1_900,
        "reasoning": 2_600,
        "cache": {"read": 136_000, "write": 6_000},
        "total": 334_500,
    }


def test_request_without_last_usage_selects_its_rate_from_the_delta():
    state = CodexTurnEvents(
        "m",
        "thread",
        "turn",
        "gpt-6.1-sol",
        counts(100_000),
        price=PRICE,
        rate_limits=CodexRateLimits(),
    )
    # The delta (172,001 input) stays at base rates, although the thread total exceeds 272k.
    assert usage(state, counts(272_001))["cost"] == 0.344002


@pytest.mark.parametrize(("input_tokens", "expected_cost"), [(220_000, 0.44), (300_000, 1.2)])
def test_usage_for_several_requests_in_one_update_is_an_estimate(input_tokens, expected_cost):
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, price=PRICE, rate_limits=CodexRateLimits()
    )
    # Earlier requests were not reported on their own; only the last 10k is known.
    projected = usage(state, counts(input_tokens), last=counts(10_000))
    assert not state.requests_separable
    assert "cost" not in projected
    # The estimate selects the aggregate's tier, not the last 10k request's.
    assert projected["messageCostUsd"] == expected_cost
    assert projected["tokens"]["input"] == input_tokens


def _turn():
    return CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())


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


def _notice(method, **params):
    return {"method": method, "params": params}


def _turn_completed(status, error=None, *, turn_id="turn"):
    return _notice(
        "turn/completed",
        threadId="thread",
        turn={"id": turn_id, "status": status, "error": error},
    )


@pytest.mark.parametrize(
    ("info", "expected"),
    [
        ("unauthorized", "Reconnect the OpenAI account in Settings (or check OPENAI_API_KEY)"),
        ("usageLimitExceeded", "usage limit reached"),
        ("rateLimitExceeded", "rate limit reached"),
        ("contextWindowExceeded", "context window"),
        ("serverOverloaded", "overloaded"),
        ("sandboxError", "native detail"),
        ({"httpConnectionFailed": {"httpStatusCode": 502}}, "native detail"),
        (None, "native detail"),
    ],
)
def test_failed_turn_emits_one_actionable_error(info, expected):
    state = _turn()
    events = state.accept(
        _turn_completed("failed", {"message": "native detail", "codexErrorInfo": info})
    )
    assert state.status == "failed"
    assert expected in state.error
    assert events == [{"type": "error", "error": state.error, "messageId": "m"}]
    # A duplicate terminal frame never reports the failure twice.
    assert state.accept(_turn_completed("failed", {"message": "again"})) == []
    assert expected in state.error


def test_failed_turn_without_detail_falls_back_and_flushes_text_first(monkeypatch):
    # A fixed clock keeps the second delta pending until the terminal frame.
    monkeypatch.setattr("sandbox_runtime.harness.codex.events.time.monotonic", lambda: 0.0)
    state = _turn()
    state.accept(_frame("item/agentMessage/delta", itemId="a", delta="hi"))
    assert state.accept(_frame("item/agentMessage/delta", itemId="a", delta=" there")) == []
    events = state.accept(_turn_completed("failed"))
    assert [(event["type"], event.get("content")) for event in events] == [
        ("token", "hi there"),
        ("error", None),
    ]
    assert state.error == events[1]["error"] == "Codex turn failed"


@pytest.mark.parametrize("status", ["completed", "interrupted"])
def test_non_failed_turn_reports_no_error(status):
    state = _turn()
    state.accept(
        _notice(
            "error",
            threadId="thread",
            turnId="turn",
            willRetry=False,
            error={"message": "late", "codexErrorInfo": "other"},
        )
    )
    assert state.accept(_turn_completed(status, {"message": "x"})) == []
    assert state.error is None


def test_retried_error_warns_and_fatal_error_feeds_terminal_failure():
    state = _turn()
    retry = _notice(
        "error",
        threadId="thread",
        turnId="turn",
        willRetry=True,
        error={"message": "Reconnecting... 1/5", "codexErrorInfo": "serverOverloaded"},
    )
    assert state.accept(retry) == [
        {
            "type": "warning",
            "scope": "provider",
            "message": "Codex hit an error and is retrying: Reconnecting... 1/5",
        }
    ]
    assert state.accept(retry) == []
    fatal = _notice(
        "error",
        threadId="thread",
        turnId="turn",
        willRetry=False,
        error={"message": "quota", "codexErrorInfo": "usageLimitExceeded"},
    )
    assert state.accept(fatal) == []
    assert state.error is None
    events = state.accept(_turn_completed("failed"))
    assert events == [
        {
            "type": "error",
            "error": "OpenAI usage limit reached; retry after it resets.",
            "messageId": "m",
        }
    ]


def test_pending_fatal_error_is_reported_once_without_turn_completion():
    state = _turn()
    assert state.fail_pending() == []
    state.accept(
        _notice(
            "error",
            threadId="thread",
            turnId="turn",
            willRetry=False,
            error={"message": "quota", "codexErrorInfo": "usageLimitExceeded"},
        )
    )
    assert state.fail_pending() == [
        {
            "type": "error",
            "error": "OpenAI usage limit reached; retry after it resets.",
            "messageId": "m",
        }
    ]
    assert state.fail_pending() == []
    assert state.status is None


@pytest.mark.parametrize("malformed", ["boom", ["boom"], 1])
def test_malformed_completion_error_keeps_recorded_native_error(malformed):
    state = _turn()
    state.accept(
        _notice(
            "error",
            threadId="thread",
            turnId="turn",
            willRetry=False,
            error={"message": "quota", "codexErrorInfo": "usageLimitExceeded"},
        )
    )
    state.accept(_turn_completed("failed", malformed))
    assert state.error == "OpenAI usage limit reached; retry after it resets."


def test_error_notifications_are_correlated_to_this_turn():
    state = _turn()
    for thread_id, turn_id in [("other", "turn"), ("thread", "other")]:
        assert (
            state.accept(
                _notice(
                    "error",
                    threadId=thread_id,
                    turnId=turn_id,
                    willRetry=True,
                    error={"message": "elsewhere"},
                )
            )
            == []
        )
    assert state.accept(_turn_completed("failed", turn_id="other")) == []
    assert state.status is None and state.error is None


@pytest.mark.parametrize(
    ("frame", "message"),
    [
        (_notice("warning", message="Process-wide notice"), "Process-wide notice"),
        (_notice("warning", message="Thread notice", threadId="thread"), "Thread notice"),
        (
            _notice("configWarning", summary="Ignored unknown key", details="secret-ish detail"),
            "Ignored unknown key",
        ),
        (
            _notice("guardianWarning", message="Guardian notice", threadId="thread"),
            "Guardian notice",
        ),
        (
            _notice(
                "model/rerouted",
                threadId="thread",
                turnId="turn",
                fromModel="gpt-6.1-sol",
                toModel="gpt-6.1-mini",
                reason="highRiskCyberActivity",
            ),
            "Codex switched this turn from gpt-6.1-sol to gpt-6.1-mini (high risk cyber activity)",
        ),
        (
            _notice(
                "modelProvider/authRecoveryStarted",
                threadId="thread",
                turnId="turn",
                provider="openai",
                message="Refreshing credentials",
            ),
            "Codex is recovering openai authentication: Refreshing credentials",
        ),
        (
            _notice(
                "modelProvider/authRecoveryCompleted",
                threadId="thread",
                turnId="turn",
                provider="openai",
                message="",
            ),
            "Codex finished recovering openai authentication",
        ),
    ],
)
def test_provider_notices_become_deduplicated_warnings(frame, message):
    state = _turn()
    assert state.accept(frame) == [{"type": "warning", "scope": "provider", "message": message}]
    assert state.accept(frame) == []


@pytest.mark.parametrize(
    "frame",
    [
        _notice("warning", message="Other thread", threadId="other"),
        _notice("guardianWarning", message="Other thread", threadId="other"),
        _notice("warning", message="   "),
        _notice("warning", message=None),
        _notice("deprecationNotice", summary="Old flag"),
        _notice(
            "model/rerouted",
            threadId="thread",
            turnId="other",
            fromModel="a",
            toModel="b",
            reason="highRiskCyberActivity",
        ),
        _notice(
            "modelProvider/authRecoveryStarted",
            threadId="thread",
            turnId="other",
            provider="openai",
            message="x",
        ),
    ],
)
def test_unrelated_or_empty_notices_are_dropped(frame):
    state = _turn()
    assert state.accept(frame) == []


def test_long_native_diagnostics_are_clipped():
    from sandbox_runtime.harness.codex.events import MAX_DIAGNOSTIC_CHARS

    state = _turn()
    [warning] = state.accept(_notice("warning", message="x" * 10_000))
    assert len(warning["message"]) == MAX_DIAGNOSTIC_CHARS
    state.accept(_turn_completed("failed", {"message": "y\n" * 10_000}))
    assert len(state.error) == MAX_DIAGNOSTIC_CHARS
    assert "\n" not in state.error


@pytest.mark.parametrize(
    ("native", "leaked"),
    [
        ("Authorization: Bearer abc.def-ghi_jkl", "abc.def-ghi_jkl"),
        ('401 {"error": {"api_key": "sk-proj-SyntheticFixtureKey"}}', "SyntheticFixtureKey"),
        ("Incorrect API key provided: sk-SyntheticFixture1234", "SyntheticFixture1234"),
        ("token=opaque-value; retry", "opaque-value"),
        ("access eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl rejected", "eyJzdWIiOiIxIn0"),
        ("session 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc expired", "9f8e7d6c5b4a3928"),
    ],
)
def test_native_diagnostics_redact_credentials(native, leaked):
    state = _turn()
    retry = _notice(
        "error", threadId="thread", turnId="turn", willRetry=True, error={"message": native}
    )
    [warning] = state.accept(retry)
    [config] = state.accept(_notice("configWarning", summary=native))
    [error] = state.accept(_turn_completed("failed", {"message": native}))
    for text in (warning["message"], config["message"], error["error"], state.error):
        assert leaked not in text
        assert "***" in text


def test_redaction_keeps_ordinary_diagnostics_readable():
    state = _turn()
    message = "stream disconnected before completion: Reconnecting... 2/5 (gpt-6.1-sol)"
    [warning] = state.accept(_notice("warning", message=message))
    assert warning["message"] == message


def _rate_limits(**snapshot):
    return _notice("account/rateLimits/updated", rateLimits=snapshot)


def test_rate_limit_updates_below_threshold_are_silent():
    state = _turn()
    assert state.accept(_rate_limits(primary={"usedPercent": 89})) == []
    assert state.accept(_rate_limits(credits={"hasCredits": False, "unlimited": False})) == []
    assert state.accept(_rate_limits()) == []
    assert state.accept(_notice("account/rateLimits/updated", rateLimits=None)) == []


def test_rate_limit_warns_once_per_limit_state():
    state = _turn()
    near = _rate_limits(
        primary={"usedPercent": 92, "windowDurationMins": 300, "resetsAt": 1_800_000_000}
    )
    assert state.accept(near) == [
        {
            "type": "warning",
            "scope": "provider",
            "message": "OpenAI 5-hour limit 92% used, resets 2027-01-15 08:00 UTC.",
        }
    ]
    # Rolling updates within the same state stay quiet.
    assert state.accept(_rate_limits(primary={"usedPercent": 95})) == []
    reached = _rate_limits(
        rateLimitReachedType="rate_limit_reached",
        primary={"usedPercent": 100},
        secondary={"usedPercent": 40, "windowDurationMins": 10080},
    )
    # Omitted window metadata is carried over from the earlier update.
    assert [event["message"] for event in state.accept(reached)] == [
        "OpenAI rate limit reached; 5-hour limit 100% used, resets 2027-01-15 08:00 UTC."
    ]
    assert state.accept(reached) == []


def test_sparse_rate_limit_updates_merge_into_the_last_snapshot():
    state = _turn()
    first = _rate_limits(limitId="quota-a", primary={"usedPercent": 92, "windowDurationMins": 300})
    [warning] = state.accept(first)
    assert warning["message"] == "OpenAI 5-hour limit 92% used."
    # A missing limitId (or null field) does not clear the last known value.
    assert state.accept(_rate_limits(primary={"usedPercent": 95}, limitName=None)) == []
    assert state.accept(_rate_limits(limitId=None, primary={"usedPercent": 96})) == []
    # A separately updated window is combined with the retained one.
    [both] = state.accept(_rate_limits(secondary={"usedPercent": 90, "windowDurationMins": 10080}))
    assert both["message"] == "OpenAI 5-hour limit 96% used; 7-day limit 90% used."
    # A different limit starts from its own snapshot.
    [other] = state.accept(_rate_limits(limitId="quota-b", primary={"usedPercent": 91}))
    assert other["message"] == "OpenAI primary limit 91% used."
    [spend] = state.accept(_rate_limits(limitId="quota-c", spendControlReached=True))
    assert spend["message"] == "OpenAI spend control limit reached."


def test_quota_state_is_retained_per_limit_id():
    limits = CodexRateLimits()
    first = {
        "limitId": "a",
        "primary": {"usedPercent": 92, "windowDurationMins": 300},
        "secondary": {"usedPercent": 90, "windowDurationMins": 10080},
    }
    assert limits.update(first) == "OpenAI 5-hour limit 92% used; 7-day limit 90% used."
    assert limits.update({"limitId": "b", "primary": {"usedPercent": 10}}) is None
    # Quota B did not discard quota A's snapshot or its warning state.
    assert limits.update({"limitId": "a", "primary": {"usedPercent": 95}}) is None
    assert limits.update({"limitId": "a", "primary": {"usedPercent": 100}}) == (
        "OpenAI 5-hour limit 100% used; 7-day limit 90% used."
    )
    # An update without a limitId belongs to the last identified quota.
    assert limits.update({"secondary": {"usedPercent": 91}}) is None


def test_quota_warning_rearms_after_recovery_or_window_reset():
    limits = CodexRateLimits()
    near = {"usedPercent": 92, "windowDurationMins": 300, "resetsAt": 1_800_000_000}
    assert limits.update({"primary": near}) is not None
    assert limits.update({"primary": {"usedPercent": 93}}) is None
    # The window reset into a new period below the threshold.
    assert limits.update({"primary": {"usedPercent": 0, "resetsAt": 1_800_018_000}}) is None
    assert limits.update({"primary": {"usedPercent": 92}}) == (
        "OpenAI 5-hour limit 92% used, resets 2027-01-15 13:00 UTC."
    )
    assert limits.update({"primary": {"usedPercent": 100}}) is not None
    # Dipping back to near and returning to reached is the same period.
    assert limits.update({"primary": {"usedPercent": 99}}) is None
    assert limits.update({"primary": {"usedPercent": 100}}) is None


def test_quota_state_outlives_the_turn_projection():
    limits = CodexRateLimits()
    update = _rate_limits(limitId="a", primary={"usedPercent": 95})

    def turn(turn_id):
        return CodexTurnEvents("m", "thread", turn_id, "gpt-6.1-sol", {}, rate_limits=limits)

    assert [event["type"] for event in turn("one").accept(update)] == ["warning"]
    assert turn("two").accept(update) == []


def _plan_frame(plan, *, thread_id="thread", turn_id="turn", **extra):
    return {
        "method": "turn/plan/updated",
        "params": {"threadId": thread_id, "turnId": turn_id, "plan": plan, **extra},
    }


def test_plan_update_projects_to_todowrite_with_web_statuses():
    state = _turn()

    events = state.accept(
        _plan_frame(
            [
                {"step": "Read code", "status": "completed"},
                {"step": "Write fix", "status": "inProgress"},
                {"step": "Run tests", "status": "pending"},
                {"step": "Future status", "status": "blocked"},
                "not a step",
                {"step": None, "status": "pending"},
                {"step": {"text": "structured"}, "status": "pending"},
            ],
            explanation="Fixing the bug",
        )
    )

    assert events == [
        {
            "type": "tool_call",
            "messageId": "m",
            "callId": "codex:turn:plan:1",
            "tool": "todowrite",
            "args": {
                "todos": [
                    {"content": "Read code", "status": "completed"},
                    {"content": "Write fix", "status": "in_progress"},
                    {"content": "Run tests", "status": "pending"},
                    {"content": "Future status", "status": "pending"},
                ]
            },
            "status": "completed",
            "output": "Fixing the bug",
        }
    ]


def test_each_plan_update_is_a_distinct_call():
    state = _turn()
    plan = [{"step": "Work", "status": "pending"}]

    first = state.accept(_plan_frame(plan))[0]
    second = state.accept(_plan_frame(plan, explanation=None))[0]

    assert (first["callId"], second["callId"]) == ("codex:turn:plan:1", "codex:turn:plan:2")
    assert second["output"] == ""


@pytest.mark.parametrize("plan", [[], None])
def test_empty_plan_clears_tasks(plan):
    state = _turn()

    [event] = state.accept(_plan_frame(plan))

    assert event["tool"] == "todowrite"
    assert event["args"] == {"todos": []}


@pytest.mark.parametrize("ids", [{"thread_id": "other"}, {"turn_id": "other"}])
def test_plan_updates_for_other_threads_or_turns_are_ignored(ids):
    state = _turn()

    assert state.accept(_plan_frame([{"step": "Work", "status": "pending"}], **ids)) == []
    assert state.accept(_plan_frame([]))[0]["callId"] == "codex:turn:plan:1"
