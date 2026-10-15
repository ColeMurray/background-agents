import json
from copy import deepcopy

import pytest

from sandbox_runtime.event_size import MAX_EVENT_BYTES, event_size_bytes
from sandbox_runtime.harness.codex.events import MAX_PRICING_SNAPSHOT_BYTES, CodexTurnEvents
from tests.event_forwarder_fakes import make_forwarder, open_ws, sent_events


@pytest.fixture
def pricing_model():
    return {"cost": {"input": 2, "output": 8, "cache_read": 0.5, "cache_write": 3}}


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


def test_usage_charges_only_this_turn_and_counts_cache_and_reasoning_once(pricing_model):
    prior = {
        "inputTokens": 1000,
        "cachedInputTokens": 500,
        "cacheWriteInputTokens": 100,
        "outputTokens": 100,
        "reasoningOutputTokens": 50,
        "totalTokens": 1100,
    }
    state = CodexTurnEvents(
        "m2", "thread", "turn2", "gpt-6.1-sol", prior, pricing_model=pricing_model
    )
    total = {
        "inputTokens": 2000,
        "cachedInputTokens": 1000,
        "cacheWriteInputTokens": 200,
        "outputTokens": 200,
        "reasoningOutputTokens": 100,
        "totalTokens": 2200,
    }
    frame = {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": "thread",
            "turnId": "turn2",
            "tokenUsage": {"total": total, "last": prior},
        },
    }
    projected = state.accept(frame)[0]
    assert projected["tokens"]["total"] == 1100
    assert projected["tokens"]["input"] == 400
    assert projected["tokens"]["output"] == 50
    assert projected["tokens"]["reasoning"] == 50
    assert projected["tokens"]["cache"] == {"read": 500, "write": 100}
    expected = (400 * 2 + 500 * 0.5 + 100 * 3 + 100 * 8) / 1_000_000
    assert projected["cost"] == pytest.approx(expected)
    assert projected["messageCostUsd"] == pytest.approx(expected)
    assert projected["pricing"] == {
        "source": "models.dev",
        "model": "openai/gpt-6.1-sol",
        "rates": pricing_model["cost"],
    }
    assert state.accept(frame) == [projected]
    assert state.finish()["cost"] == pytest.approx(expected)
    assert state.cost_complete


def usage(state, total, last=None):
    return state.accept(
        {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": state.thread_id,
                "turnId": state.turn_id,
                "tokenUsage": {"total": total, **({"last": last} if last is not None else {})},
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


@pytest.mark.parametrize("mutated_snapshot", ["catalog", "event"])
def test_pricing_snapshot_is_immutable(pricing_model, mutated_snapshot):
    pricing_model["cost"]["tiers"] = [
        {"input": 4, "output": 16, "tier": {"type": "context", "size": 100}}
    ]
    expected_pricing = {
        "source": "models.dev",
        "model": "openai/gpt-6.1-sol",
        "rates": deepcopy(pricing_model["cost"]),
    }
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    first = usage(state, counts(50), counts(50))
    assert first["pricing"] == expected_pricing
    rates = pricing_model["cost"] if mutated_snapshot == "catalog" else first["pricing"]["rates"]
    rates["input"] = 99
    rates["tiers"][0]["input"] = 999

    second = usage(state, counts(200), counts(150))
    assert second["cost"] == pytest.approx((50 * 2 + 150 * 4) / 1_000_000)
    assert second["pricing"] == expected_pricing
    assert state.finish()["pricing"] == expected_pricing
    if mutated_snapshot == "catalog":
        assert first["pricing"] == expected_pricing


@pytest.mark.parametrize("oversized_field", ["extra", "tier", "tiers"])
async def test_oversized_pricing_metadata_does_not_drop_live_cost_updates(
    pricing_model, oversized_field
):
    if oversized_field == "extra":
        pricing_model["cost"]["extra"] = "x" * (MAX_EVENT_BYTES + 100_000)
    elif oversized_field == "tier":
        pricing_model["cost"]["tiers"] = [
            {
                "input": 4,
                "output": 16,
                "tier": {"type": "context", "size": 1000},
                "extra": "x" * (MAX_EVENT_BYTES + 100_000),
            }
        ]
    else:
        pricing_model["cost"]["tiers"] = [
            {"input": 4, "output": 16, "tier": {"type": "context", "size": size}}
            for size in range(1000, 17000)
        ]
    assert event_size_bytes(pricing_model) > MAX_EVENT_BYTES
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    forwarder = make_forwarder()
    ws = open_ws()
    await forwarder.bind(ws)

    for total, expected_cost in [(100, 0.0002), (200, 0.0004)]:
        event = usage(state, counts(total), counts(100))
        assert event["cost"] == pytest.approx(expected_cost)
        assert event["messageCostUsd"] == pytest.approx(expected_cost)
        assert "pricing" not in event
        assert await forwarder.send(event)
        assert event_size_bytes(event) < MAX_EVENT_BYTES
    assert [event["messageCostUsd"] for event in sent_events(ws)] == pytest.approx([0.0002, 0.0004])
    assert state.cost_complete


@pytest.mark.parametrize("extra_bytes", [0, 1])
def test_pricing_snapshot_byte_limit(pricing_model, extra_bytes):
    snapshot = {
        "source": "models.dev",
        "model": "openai/gpt-6.1-sol",
        "rates": {**pricing_model["cost"], "extra": ""},
    }
    snapshot["rates"]["extra"] = "x" * (
        MAX_PRICING_SNAPSHOT_BYTES - event_size_bytes(snapshot) + extra_bytes
    )
    state = CodexTurnEvents(
        "m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model={"cost": snapshot["rates"]}
    )
    event = usage(state, counts(100), counts(100))
    assert ("pricing" in event) is (extra_bytes == 0)
    assert event["messageCostUsd"] == pytest.approx(0.0002)


@pytest.mark.parametrize("third_input,third_rate", [(100_000, 2), (100_001, 4)])
def test_context_tiers_use_each_response_not_accumulated_turn_input(
    pricing_model, third_input, third_rate
):
    pricing_model["cost"]["tiers"] = [
        {"input": 4, "output": 16, "tier": {"type": "context", "size": 100_000}}
    ]
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    assert usage(state, counts(60_000), counts(60_000))["cost"] == pytest.approx(0.12)
    second = usage(state, counts(120_000), counts(60_000))
    assert second["cost"] == pytest.approx(0.24)
    third = usage(state, counts(120_000 + third_input), counts(third_input))
    expected = 0.24 + third_input * third_rate / 1_000_000
    assert third["cost"] == pytest.approx(expected)
    assert third["messageCostUsd"] == pytest.approx(expected)
    assert third["tokens"]["input"] == 120_000 + third_input
    assert usage(state, counts(120_000 + third_input), counts(third_input)) == third

    following = CodexTurnEvents(
        "m2", "thread", "turn2", "gpt-6.1-sol", state.total, pricing_model=pricing_model
    )
    resumed = usage(following, counts(180_000 + third_input), counts(60_000))
    assert resumed["tokens"]["input"] == 60_000
    assert resumed["cost"] == pytest.approx(0.12)
    assert resumed["messageCostUsd"] == pytest.approx(0.12)


@pytest.mark.parametrize(
    "pricing_model,cache_field",
    [
        (None, None),
        ({}, None),
        ({"cost": {}}, None),
        ({"cost": {"input": 2}}, None),
        ({"cost": {"output": 8}}, None),
        ({"cost": {"input": 2, "output": 8}}, "cachedInputTokens"),
        ({"cost": {"input": 2, "output": 8}}, "cacheWriteInputTokens"),
    ],
)
def test_missing_rates_leave_coverage_incomplete_but_allow_later_pricing(
    pricing_model, cache_field
):
    state = CodexTurnEvents("m", "thread", "turn", "test-model", {}, pricing_model=pricing_model)
    total = counts(100)
    if cache_field:
        total[cache_field] = 20
    projected = usage(state, total, total)
    assert projected["tokens"]["total"] == 100
    assert projected["cost"] is None
    assert "messageCostUsd" not in projected
    assert "pricing" not in projected
    assert state.has_usage
    assert not state.cost_complete
    # A cache-free response can be priced without filling the earlier accounting gap.
    later = usage(state, {**total, "inputTokens": 110, "totalTokens": 110}, counts(10))
    assert later["cost"] is None
    if cache_field:
        assert later["messageCostUsd"] == pytest.approx(10 * 2 / 1_000_000)
        assert later["pricing"]["rates"] == pricing_model["cost"]
    else:
        assert "messageCostUsd" not in later
        assert "pricing" not in later
    assert state.finish() == later
    assert not state.cost_complete


@pytest.mark.parametrize("priced_subtotal", [False, True])
@pytest.mark.parametrize(
    "last",
    [None, [], {}, {**counts(50), "inputTokens": True}, counts(49), counts(100)],
    ids=["missing", "non-object", "empty", "malformed", "gap", "not-response-delta"],
)
def test_invalid_last_preserves_subtotal_and_allows_later_matched_pricing(
    pricing_model, priced_subtotal, last
):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    baseline = 0
    if priced_subtotal:
        assert usage(state, counts(100), counts(100))["cost"] == pytest.approx(0.0002)
        baseline = 100

    projected = usage(state, counts(baseline + 50), last)
    assert projected["cost"] is None
    assert projected["tokens"]["input"] == baseline + 50
    assert state.has_usage
    assert not state.cost_complete
    if priced_subtotal:
        assert projected["messageCostUsd"] == pytest.approx(0.0002)
        assert projected["pricing"]["rates"] == pricing_model["cost"]
    else:
        assert "messageCostUsd" not in projected
        assert "pricing" not in projected
    assert usage(state, counts(baseline + 50), last) == projected

    later = usage(state, counts(baseline + 100), counts(50))
    assert later["cost"] is None
    assert later["tokens"]["input"] == baseline + 100
    assert not state.cost_complete
    for event in (later, state.finish()):
        assert event["cost"] is None
        assert event["messageCostUsd"] == pytest.approx((baseline + 50) * 2 / 1_000_000)
        assert event["pricing"]["rates"] == pricing_model["cost"]


def test_nonmonotonic_totals_preserve_priced_highwater(pricing_model):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    priced = usage(state, counts(100), counts(100))
    assert priced["cost"] == pytest.approx(0.0002)
    projected = usage(state, counts(99), counts(0))
    later = usage(state, counts(200), counts(100))
    for event in (projected, later, state.finish()):
        assert event["cost"] is None
        assert event["messageCostUsd"] == pytest.approx(0.0002)
        assert event["pricing"] == priced["pricing"]
        assert "tokens" not in event
    assert state.total["inputTokens"] == 100
    assert not state.has_usage
    assert not state.cost_complete


@pytest.mark.parametrize("priced_subtotal", [False, True])
def test_model_reroute_freezes_subtotal_instead_of_guessing(pricing_model, priced_subtotal):
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {}, pricing_model=pricing_model)
    if priced_subtotal:
        usage(state, counts(100), counts(100))
    [rerouted] = state.accept(
        _frame("model/rerouted", fromModel="gpt-6.1-sol", toModel="other-model")
    )
    later = usage(state, counts(150), counts(50 if priced_subtotal else 150))
    for event in (rerouted, later, state.finish()):
        assert event["cost"] is None
        if priced_subtotal:
            assert event["messageCostUsd"] == pytest.approx(0.0002)
            assert event["pricing"] == {
                "source": "models.dev",
                "model": "openai/gpt-6.1-sol",
                "rates": pricing_model["cost"],
            }
        else:
            assert "messageCostUsd" not in event
            assert "pricing" not in event
    assert later["tokens"]["input"] == 150
    assert not state.cost_complete


def test_unknown_cancelled_baseline_does_not_attribute_previous_turn_tokens(pricing_model):
    state = CodexTurnEvents(
        "m2",
        "thread",
        "turn2",
        "gpt-6.1-sol",
        counts(100),
        baseline_known=False,
        pricing_model=pricing_model,
    )
    # The native history includes 50 previously unobserved tokens, then this turn's 10.
    projected = usage(state, counts(160), counts(60))
    assert projected["cost"] is None
    assert "messageCostUsd" not in projected
    assert "pricing" not in projected
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert state.has_usage
    assert state.total["inputTokens"] == 160
    later = usage(state, counts(170), counts(10))
    assert later["cost"] is None
    assert "messageCostUsd" not in later
    assert "tokens" not in later
    assert not state.cost_complete

    following = CodexTurnEvents(
        "m3", "thread", "turn3", "gpt-6.1-sol", state.total, pricing_model=pricing_model
    )
    projected = usage(following, counts(180), counts(10))
    assert projected["tokens"]["input"] == 10
    assert projected["cost"] == pytest.approx(10 * 2 / 1_000_000)
    assert projected["messageCostUsd"] == projected["cost"]
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
def test_malformed_usage_does_not_invent_tokens(invalid, pricing_model):
    state = CodexTurnEvents("m", "thread", "turn", "test-model", {}, pricing_model=pricing_model)
    assert usage(state, counts(50))["cost"] is None
    projected = usage(state, invalid)
    assert projected["cost"] is None
    assert "messageCostUsd" not in projected
    assert "costAvailability" not in projected
    assert "tokens" not in projected
    assert not state.has_usage
    assert state.total["inputTokens"] == 50
    # A later clean frame cannot retroactively make this malformed series trustworthy.
    later = usage(state, counts(200), counts(150))
    assert later["cost"] is None
    assert "messageCostUsd" not in later
    assert not state.has_usage
    assert not state.usage_valid


def test_absolute_valid_but_overlapping_delta_cannot_be_attributed():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100))
    assert usage(state, {**counts(100), "cachedInputTokens": 1})["cost"] is None
    assert not state.has_usage


def test_unknown_baseline_tracks_valid_totals_without_using_unsafe_deltas():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", counts(100), baseline_known=False)
    assert usage(state, {**counts(160), "cachedInputTokens": 150})["cost"] is None
    assert state.has_usage
    assert state.total["cachedInputTokens"] == 150


def test_no_usage_and_nonmonotonic_series_cannot_establish_a_safe_baseline():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {})
    assert not state.has_usage
    assert state.finish()["cost"] is None
    assert "messageCostUsd" not in state.finish()
    usage(state, counts(100))
    assert usage(state, counts(99))["cost"] is None
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
    assert projected["cost"] is None
    assert "messageCostUsd" not in projected
    assert not state.has_usage


@pytest.mark.parametrize("last", [None, counts(0), counts(100)])
def test_unknown_model_duplicate_usage_does_not_invent_zero_cost(last):
    state = CodexTurnEvents("m", "thread", "turn", "unknown-model", {})
    first = usage(state, counts(100), counts(100))
    for event in (first, usage(state, counts(100), last), state.finish()):
        assert event["cost"] is None
        assert "messageCostUsd" not in event
        assert "pricing" not in event
        assert event["tokens"]["total"] == 100
    assert not state.cost_complete


def test_zero_usage_is_authoritative_and_cost_is_zero_for_unknown_models():
    state = CodexTurnEvents("m", "thread", "turn", "unknown-model", {})
    projected = usage(state, counts(0))
    assert state.has_usage
    assert projected["tokens"]["total"] == 0
    assert projected["cost"] == 0
    assert projected["messageCostUsd"] == 0
    assert "pricing" not in projected
    assert state.cost_complete
    assert "costAvailability" not in projected


def test_invalid_restored_baseline_can_recover_authoritative_totals():
    state = CodexTurnEvents("m", "thread", "turn", "gpt-6.1-sol", {"inputTokens": True})
    projected = usage(state, counts(10), counts(10))
    assert projected["cost"] is None
    assert "messageCostUsd" not in projected
    assert "tokens" not in projected
    assert state.has_usage
    assert state.total["inputTokens"] == 10


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
    assert [(e["type"], e.get("content")) for e in events if e["type"] != "step_finish"] == [
        ("token", "Before"),
        ("token", "Before more"),
        ("context_compacted", None),
        ("token", "After"),
    ]
    assert not turn.cost_complete


def test_compaction_keeps_pricing_matched_responses_with_incomplete_coverage(pricing_model):
    turn = CodexTurnEvents("m", "thread", "turn", "test-model", {}, pricing_model=pricing_model)
    priced = usage(turn, counts(100), counts(100))
    assert priced["cost"] == pytest.approx(100 * 2 / 1_000_000)
    events = turn.accept(_item("item/started", {"type": "contextCompaction", "id": "c"}))
    assert not turn.cost_complete
    events += turn.accept(_item("item/completed", {"type": "contextCompaction", "id": "c"}))
    assert [event["type"] for event in events] == [
        "step_finish",
        "context_compacted",
        "step_finish",
    ]
    for event in events:
        if event["type"] == "step_finish":
            assert event["cost"] is None
            assert event["messageCostUsd"] == priced["messageCostUsd"]
    duplicate = usage(turn, counts(100), counts(100))
    assert duplicate["cost"] is None
    assert duplicate["messageCostUsd"] == priced["messageCostUsd"]

    later = usage(turn, counts(150), counts(50))
    for event in (later, turn.finish()):
        assert event["cost"] is None
        assert event["messageCostUsd"] == pytest.approx(150 * 2 / 1_000_000)
        assert event["pricing"] == priced["pricing"]
        assert event["tokens"]["input"] == 150
    assert not turn.cost_complete


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
