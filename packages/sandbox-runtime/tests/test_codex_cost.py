"""Turn cost reporting by the native Codex harness."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.client import CodexTransportError
from sandbox_runtime.model_prices import ModelPriceCatalog

# gpt-6.1-sol: $2/M input, $10/M output and reasoning.
CATALOG = {
    "openai": {"models": {"gpt-6.1-sol": {"cost": {"input": 2, "output": 10, "cache_read": 0.1}}}}
}


def tokens(input_tokens, output_tokens=0):
    return {
        "inputTokens": input_tokens,
        "cachedInputTokens": 0,
        "outputTokens": output_tokens,
        "reasoningOutputTokens": 0,
        "totalTokens": input_tokens + output_tokens,
    }


def usage(turn_id, total, last):
    return {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": "thread",
            "turnId": turn_id,
            "tokenUsage": {"total": total, "last": last},
        },
    }


def completed(turn_id, status="completed"):
    return {
        "method": "turn/completed",
        "params": {"threadId": "thread", "turn": {"id": turn_id, "status": status}},
    }


def build(tmp_path, notifications, *, catalog=CATALOG, model="gpt-6.1-sol"):
    path = tmp_path / "models.json"
    if catalog is not None:
        path.write_text(json.dumps(catalog))
    client = MagicMock()
    client.running = True
    client.open = AsyncMock()
    client.close = AsyncMock(return_value=True)
    client.notify = AsyncMock()
    turns = iter(f"turn-{n}" for n in range(1, 10))

    async def request(method, params, **kwargs):
        if method == "thread/start":
            return {"thread": {"id": "thread"}}
        if method == "turn/start":
            return {"turn": {"id": next(turns)}}
        return {"account": {"type": "apiKey"}}

    client.request = AsyncMock(side_effect=request)
    frames = iter(notifications)

    async def next_notification():
        frame = next(frames)
        if isinstance(frame, Exception):
            raise frame
        return frame

    client.next_notification = AsyncMock(side_effect=next_notification)
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "native", model, False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=MagicMock(return_value=client),
        environ={"OPENAI_API_KEY": "fixture"},
        prices=ModelPriceCatalog(path, MagicMock()),
    )
    return harness


async def run(harness, message_id="m"):
    events = []

    async def emit(event):
        events.append(event)

    outcome = await harness.run_prompt(HarnessPrompt(message_id, "work"), emit)
    return outcome, events


def finishes(events):
    return [event for event in events if event["type"] == "step_finish"]


def warnings(events):
    return [event["message"] for event in events if event["type"] == "warning"]


async def test_completed_turn_reports_cumulative_cost_on_every_step_and_the_outcome(tmp_path):
    harness = build(
        tmp_path,
        [
            usage("turn-1", tokens(1_000, 100), tokens(1_000, 100)),
            usage("turn-1", tokens(3_000, 300), tokens(2_000, 200)),
            completed("turn-1"),
        ],
    )
    outcome, events = await run(harness)
    assert outcome.success
    # 3000 input at $2/M and 300 output at $10/M.
    assert outcome.message_cost_usd == 0.009
    assert [(e.get("cost"), e["messageCostUsd"]) for e in finishes(events)] == [
        (0.003, 0.003),
        (0.009, 0.009),
        (0.009, 0.009),
    ]
    assert warnings(events) == []


@pytest.mark.parametrize(
    ("catalog", "model", "message"),
    [
        (None, "gpt-6.1-sol", "Model prices are unavailable in this sandbox"),
        (CATALOG, "gpt-next", "No price is listed for gpt-next in this sandbox"),
    ],
)
async def test_unpriced_turn_omits_cost_and_warns(tmp_path, catalog, model, message):
    harness = build(
        tmp_path,
        [usage("turn-1", tokens(1_000), tokens(1_000)), completed("turn-1")],
        catalog=catalog,
        model=model,
    )
    outcome, events = await run(harness)
    assert outcome.success
    assert outcome.message_cost_usd == 0
    assert all("cost" not in event and event["messageCostUsd"] == 0 for event in finishes(events))
    assert finishes(events)[-1]["tokens"]["input"] == 1_000
    [warning] = warnings(events)
    assert warning.startswith(message)
    assert warning.endswith("so this turn's cost is recorded as $0.")


async def test_turn_without_usage_is_free_and_not_warned(tmp_path):
    outcome, events = await run(build(tmp_path, [completed("turn-1")]))
    assert outcome.message_cost_usd == 0
    assert finishes(events)[-1]["cost"] == 0
    assert warnings(events) == []


async def test_interrupted_turn_keeps_its_cost_and_the_next_turn_is_priced_per_request(tmp_path):
    harness = build(
        tmp_path,
        [
            usage("turn-1", tokens(1_000), tokens(1_000)),
            completed("turn-1", "interrupted"),
            # 100 tokens of native history the interrupted turn never reported,
            # then this turn's own 500-token request.
            usage("turn-2", tokens(1_600), tokens(500)),
            completed("turn-2"),
        ],
    )
    outcome, events = await run(harness, "m1")
    assert outcome.cancelled
    assert outcome.message_cost_usd == 0.002
    assert finishes(events)[-1]["cost"] == 0.002

    outcome, events = await run(harness, "m2")
    assert outcome.success
    assert outcome.message_cost_usd == 0.001
    assert finishes(events)[-1]["cost"] == 0.001
    assert finishes(events)[-1]["tokens"]["input"] == 500
    assert warnings(events) == []


async def test_usage_that_cannot_be_separated_from_earlier_work_is_unpriced(tmp_path):
    no_last = usage("turn-2", tokens(1_600), tokens(500))
    del no_last["params"]["tokenUsage"]["last"]
    harness = build(
        tmp_path,
        [
            usage("turn-1", tokens(1_000), tokens(1_000)),
            completed("turn-1", "interrupted"),
            no_last,
            completed("turn-2"),
        ],
    )
    await run(harness, "m1")
    outcome, events = await run(harness, "m2")
    assert outcome.success
    assert outcome.message_cost_usd == 0
    assert all("cost" not in event and "tokens" not in event for event in finishes(events))
    [warning] = warnings(events)
    assert "could not be separated from earlier work" in warning


async def test_inconsistent_usage_keeps_the_cost_reported_before_it_and_warns(tmp_path):
    harness = build(
        tmp_path,
        [
            usage("turn-1", tokens(1_000), tokens(1_000)),
            usage("turn-1", tokens(900), tokens(900)),
            completed("turn-1"),
        ],
    )
    outcome, events = await run(harness)
    assert outcome.message_cost_usd == 0.002
    assert "cost" not in finishes(events)[-1]
    [warning] = warnings(events)
    assert warning.startswith("Codex reported inconsistent token usage")


async def test_usage_reported_for_several_requests_together_is_an_estimate(tmp_path):
    harness = build(
        tmp_path,
        [usage("turn-1", tokens(3_000), tokens(1_000)), completed("turn-1")],
    )
    outcome, events = await run(harness)
    assert outcome.message_cost_usd == 0.006
    assert "cost" not in finishes(events)[-1]
    [warning] = warnings(events)
    assert warning.startswith("Codex did not report this turn's usage one request at a time")


async def test_transport_failure_reports_the_cost_observed_before_it(tmp_path):
    harness = build(
        tmp_path,
        [usage("turn-1", tokens(1_000), tokens(1_000)), CodexTransportError("gone")],
    )
    outcome, events = await run(harness)
    assert not outcome.success
    assert outcome.message_cost_usd == 0.002
    assert finishes(events)[-1]["messageCostUsd"] == 0.002


async def test_recorded_native_failure_reports_the_cost_observed_before_it(tmp_path):
    fatal = {
        "method": "error",
        "params": {
            "threadId": "thread",
            "turnId": "turn-1",
            "willRetry": False,
            "error": {"message": "upstream closed"},
        },
    }
    harness = build(
        tmp_path,
        [
            usage("turn-1", tokens(1_000), tokens(1_000)),
            fatal,
            CodexTransportError("gone"),
        ],
    )
    outcome, _ = await run(harness)
    assert outcome.error == "upstream closed"
    assert outcome.message_cost_usd == 0.002


@pytest.mark.parametrize(
    ("catalog", "last", "message"),
    [
        (None, tokens(1_000), "Model prices are unavailable in this sandbox"),
        (CATALOG, tokens(400), "Codex did not report this turn's usage one request at a time"),
    ],
)
async def test_accounting_warning_is_reported_when_observed_not_at_completion(
    tmp_path, catalog, last, message
):
    harness = build(
        tmp_path,
        [usage("turn-1", tokens(1_000), last), CodexTransportError("gone")],
        catalog=catalog,
    )
    outcome, events = await run(harness)
    assert not outcome.success
    [warning] = warnings(events)
    assert warning.startswith(message)


async def test_failure_before_the_turn_starts_costs_nothing(tmp_path):
    harness = build(tmp_path, [])
    harness._factory.return_value.open.side_effect = CodexTransportError("no process")
    outcome, _ = await run(harness)
    assert not outcome.success
    assert outcome.message_cost_usd == 0
