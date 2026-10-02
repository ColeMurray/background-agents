"""Raw bounded previews and best-effort Claude trajectory logging."""

from __future__ import annotations

import asyncio
import json
import logging
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from sandbox_runtime.harness.base import TurnOutcome
from sandbox_runtime.harness.claude_logging import (
    PREVIEW_MAX_BYTES,
    TRUNCATED,
    ClaudeTrajectoryLogger,
)
from sandbox_runtime.harness.claude_translate import (
    ClaudeTranslation,
    ClaudeTranslator,
    ClaudeTurnState,
    SdkTurnResult,
    TrajectoryRecord,
)
from sandbox_runtime.log_config import JSONFormatter, get_logger


@pytest.mark.parametrize(
    "text",
    [
        'cli --password "raw value" --api-key=raw-key --token raw-token',
        "Authorization: Bearer raw-token\nAuthorization: Basic raw-basic",
        'DB_PASS=raw-password\nDATABASE_URL="postgres://user:raw-password@host/db"',
        "Cookie: session=raw-session; other=raw-cookie",
        ' \n{ "credentials" : { "apiKey" : "raw-key" }, "text" : "\u00e9" }\n ',
    ],
)
def test_raw_text_is_unchanged_without_inventory(text):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    trajectory.diagnostic("test", payload_preview=text)
    assert log.info.call_args.kwargs["payload_preview"] == text
    trajectory.stderr(text)
    assert log.info.call_args.kwargs["diagnostic_preview"] == text


def test_sensitive_key_arguments_are_unchanged_without_inventory():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    args = {
        "command": "cli --password raw-password --token raw-token",
        "nested": [{"apiKey": "raw-key", "credentials": {"custom": "raw-credential"}}],
        "env": {"DB_PASS": "raw-password"},
        "headers": {"Authorization": "Bearer raw-token"},
    }
    original = json.dumps(args, ensure_ascii=False)
    trajectory.diagnostic("test", args_preview=args)
    preview = log.info.call_args.kwargs["args_preview"]
    assert preview == original
    assert json.loads(preview) == args
    assert json.dumps(args, ensure_ascii=False) == original


def test_raised_exception_uses_canonical_metadata_and_traceback(caplog):
    caplog.set_level(logging.ERROR, logger="claude-logging-test")
    trajectory = ClaudeTrajectoryLogger(
        get_logger("claude-logging-test", sandbox_id="sb-test", session_id="oi-session")
    )

    def raise_source():
        raise RuntimeError("Authorization: Bearer raw-exception-token")

    try:
        raise_source()
    except RuntimeError as exc:
        trajectory.diagnostic("test.exception", level="error", exc=exc)
        (record,) = [
            record
            for record in caplog.records
            if record.name == "claude-logging-test" and record.getMessage() == "test.exception"
        ]
        assert record.exc_info is not None and record.exc_info[1] is exc
        frame = exc.__traceback__.tb_next
        expected_frame = f", line {frame.tb_lineno}, in raise_source"

    line = JSONFormatter().format(record)
    metadata = json.loads(line)
    assert metadata["level"] == "error" and metadata["event"] == "test.exception"
    assert metadata["sandbox_id"] == "sb-test" and metadata["session_id"] == "oi-session"
    assert metadata["error_type"] == "RuntimeError"
    assert metadata["error_message"] == "Authorization: Bearer raw-exception-token"
    stack = metadata["error_stack"]
    assert "test_claude_logging.py" in stack and expected_frame in stack
    assert 'raise RuntimeError("Authorization: Bearer raw-exception-token")' in stack
    assert "Traceback (most recent call last):" in stack
    assert "RuntimeError: Authorization: Bearer raw-exception-token" in stack
    assert "\n" not in line


@pytest.mark.parametrize("failure", ["logger", "serialization", "cyclic"])
def test_one_bad_record_does_not_suppress_later_records_or_typed_result(failure):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    delivered = []

    def write(event, **fields):
        if failure == "logger" and event == "test.bad":
            raise RuntimeError("logging handler failed")
        delivered.append((event, fields))

    log.info.side_effect = write
    token = trajectory.begin("prompt", "native")
    translation = ClaudeTranslator().translate(
        ClaudeTurnState(message_id="prompt", cost_baseline=0.0),
        ResultMessage(
            subtype="success",
            duration_ms=100,
            duration_api_ms=50,
            is_error=False,
            num_turns=2,
            session_id="native",
            total_cost_usd=0.1,
            usage={"input_tokens": 100, "output_tokens": 25},
        ),
        interrupted=False,
    )
    bad_payload = {"value": object()} if failure == "serialization" else "bad"
    if failure == "cyclic":
        bad_payload = {}
        bad_payload["nested"] = bad_payload
    translation.records.extend(
        [
            TrajectoryRecord("test.bad", {"payload_preview": bad_payload}),
            TrajectoryRecord("test.good", {"call_id": "call", "output_preview": "safe"}),
        ]
    )
    assert isinstance(translation.result, SdkTurnResult)
    assert translation.result == SdkTurnResult(
        status="success",
        is_error=False,
        duration_ms=100,
        duration_api_ms=50,
        num_turns=2,
        total_cost_usd=0.1,
        tokens={"input": 100, "output": 25},
    )
    events = [dict(event) for event in translation.events]
    trajectory.emit(translation)
    assert trajectory._turn.get().result is translation.result
    trajectory.finish(translation.outcome, token)

    assert [event for event, _fields in delivered] == ["test.good", "claude.turn.completed"]
    assert delivered[0][1]["call_id"] == "call" and delivered[0][1]["output_preview"] == "safe"
    finish = delivered[1][1]
    assert finish["sdk_status"] == "success" and not finish["sdk_is_error"]
    assert finish["sdk_duration_ms"] == 100 and finish["sdk_duration_api_ms"] == 50
    assert finish["num_turns"] == 2 and finish["total_cost_usd"] == 0.1
    assert finish["tokens"] == {"input": 100, "output": 25}
    assert translation.events == events and translation.outcome == TurnOutcome.ok(
        message_cost_usd=0.1
    )
    assert trajectory._turn.get() is None


@pytest.mark.parametrize(
    "value",
    [
        "a" * 1_000_000,
        list(range(100_000)),
        {str(index): "value" for index in range(10_000)},
        {"items": list(range(100_000)), "unvisited": object()},
    ],
)
def test_large_payload_previews_are_bounded(value):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES
    assert preview.endswith(TRUNCATED)


@pytest.mark.parametrize(
    "text",
    [
        "a" * PREVIEW_MAX_BYTES,
        "a" * (PREVIEW_MAX_BYTES + 1),
        "\u00e9" * (PREVIEW_MAX_BYTES // 2),
        "\u00e9" * (PREVIEW_MAX_BYTES // 2 + 1),
        "\U0001f680" * (PREVIEW_MAX_BYTES // 4 + 1),
    ],
)
def test_text_preview_respects_utf8_byte_limit(text):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    trajectory.diagnostic("test", payload_preview=text)
    preview = log.info.call_args.kwargs["payload_preview"]
    encoded = text.encode("utf-8")
    expected = text
    if len(encoded) > PREVIEW_MAX_BYTES:
        expected = (
            encoded[: PREVIEW_MAX_BYTES - len(TRUNCATED)].decode("utf-8", errors="ignore")
            + TRUNCATED
        )
    assert preview == expected
    assert len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES


async def test_interleaved_turns_keep_identity_deduplication_and_result_fields_isolated():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    translator = ClaudeTranslator()
    a_started = asyncio.Event()
    b_ready = asyncio.Event()
    a_finished = asyncio.Event()

    def log_messages(name, cost, duration_ms):
        state = ClaudeTurnState(message_id=name, cost_baseline=0.0)
        assistant = AssistantMessage(
            content=[
                TextBlock("same assistant text"),
                ToolUseBlock(id=name, name="Read", input={"file_path": name}),
            ],
            model="m",
            message_id="same-id",
            session_id="native",
        )
        trajectory.emit(translator.translate(state, assistant, interrupted=False))
        duplicate = translator.translate(
            state,
            AssistantMessage(
                content=[TextBlock("same assistant text")],
                model="m",
                message_id="same-id",
                session_id="native",
            ),
            interrupted=False,
        )
        assert not duplicate.records
        trajectory.emit(duplicate)
        result = translator.translate(
            state,
            ResultMessage(
                subtype="success",
                duration_ms=duration_ms,
                duration_api_ms=duration_ms,
                is_error=False,
                num_turns=1,
                session_id="native",
                total_cost_usd=cost,
                usage={"input_tokens": duration_ms},
            ),
            interrupted=False,
        )
        assert isinstance(result, ClaudeTranslation)
        assert isinstance(result.result, SdkTurnResult)
        trajectory.emit(result)
        assert trajectory._turn.get().result is result.result
        return result.outcome

    async def first():
        token = trajectory.begin("A", "native")
        a_started.set()
        await b_ready.wait()
        trajectory.finish(log_messages("A", 0.1, 100), token)
        assert trajectory._turn.get() is None
        a_finished.set()

    async def second():
        await a_started.wait()
        token = trajectory.begin("B", "native")
        outcome = log_messages("B", 0.2, 200)
        trajectory.stderr("overlapping prompts")
        b_ready.set()
        await a_finished.wait()
        trajectory.diagnostic("test.after_other_turn_finished")
        trajectory.finish(outcome, token)
        assert trajectory._turn.get() is None

    await asyncio.gather(first(), second())
    tool_logs = [
        call.kwargs for call in log.info.call_args_list if call.args[0] == "claude.tool.started"
    ]
    assert [(record["call_id"], record["message_id"]) for record in tool_logs] == [
        ("B", "B"),
        ("A", "A"),
    ]
    assistant_logs = [
        call.kwargs
        for call in log.info.call_args_list
        if call.args[0] == "claude.assistant.message"
    ]
    assert [record["message_id"] for record in assistant_logs] == ["B", "A"]
    turns = [
        call.kwargs for call in log.info.call_args_list if call.args[0] == "claude.turn.completed"
    ]
    assert [
        (
            record["message_id"],
            record["total_cost_usd"],
            record["sdk_duration_ms"],
            record["tokens"],
        )
        for record in turns
    ] == [("A", 0.1, 100, {"input": 100}), ("B", 0.2, 200, {"input": 200})]
    (after,) = [
        call.kwargs
        for call in log.info.call_args_list
        if call.args[0] == "test.after_other_turn_finished"
    ]
    assert after["message_id"] == "B"
    (stderr,) = [
        call.kwargs for call in log.info.call_args_list if call.args[0] == "claude.sdk.stderr"
    ]
    assert "message_id" not in stderr and stderr["agent_session_id"] == "native"
    assert trajectory._turn.get() is None


async def test_connection_lived_stderr_reader_does_not_reuse_its_first_turn_context():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log)
    lines = asyncio.Queue()
    acknowledged = asyncio.Queue()

    async def reader():
        while (line := await lines.get()) is not None:
            trajectory.stderr(line)
            await acknowledged.put(None)

    async def send(line):
        await lines.put(line)
        await acknowledged.get()

    first_token = trajectory.begin("A", "native")
    task = asyncio.create_task(reader())
    await send("first prompt")
    trajectory.finish(TurnOutcome.ok(), first_token)
    second_token = trajectory.begin("B", "native")
    await send("second prompt")
    trajectory.finish(TurnOutcome.ok(), second_token)
    await send("idle connection")
    await lines.put(None)
    await task
    stderr = [
        call.kwargs for call in log.info.call_args_list if call.args[0] == "claude.sdk.stderr"
    ]
    assert all(
        "message_id" not in record and record["agent_session_id"] == "native" for record in stderr
    )
