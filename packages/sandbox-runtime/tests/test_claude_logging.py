"""Security and processing bounds for Claude-only trajectory previews."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from sandbox_runtime.constants import USER_SECRET_KEYS_ENV_VAR
from sandbox_runtime.harness.base import TurnOutcome
from sandbox_runtime.harness.claude_logging import (
    CONTENT_OMITTED,
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_DEPTH,
    PREVIEW_MAX_NODES,
    REDACTED,
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


def _logger(log, environ=None, mcp_servers=(), auth_token=None):
    return ClaudeTrajectoryLogger(
        log, {USER_SECRET_KEYS_ENV_VAR: "[]", **(environ or {})}, mcp_servers, auth_token
    )


@pytest.mark.parametrize(
    "value",
    [
        {"nested": [{"DB_PASS": "sensitive", "DATABASE_URL": "sensitive"}]},
        'DB_PASS=sensitive\nDATABASE_URL="sensitive"',
        '{"credentials": {"custom": "sensitive"}}' + " " * (PREVIEW_MAX_BYTES * 4),
        'password="sensitive ' + "more sensitive " * PREVIEW_MAX_BYTES,
        "Authorization: Bearer sensitive",
        "Authorization: Basic sensitive",
        "Authorization: Token sensitive extra-sensitive",
        "Authorization: ApiKey sensitive extra-sensitive",
        "Authorization: Custom sensitive extra-sensitive",
        "Cookie: session=sensitive; other=extra-sensitive",
        "https://user:sensitive@host/path",
    ],
)
def test_sensitive_keys_and_free_text_assignments_are_redacted(value):
    log = MagicMock()
    trajectory = _logger(log)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert "sensitive" not in preview
    assert REDACTED in preview


@pytest.mark.parametrize(
    "command",
    [
        "cli --password sample-sensitive --api-key sample-api-value --verbose",
        "cli --password=sample-sensitive --api-key=sample-api-value --verbose",
        "cli --password \"sample-sensitive with spaces\" --api-key='sample-api-value' --verbose",
        "cli --password sample-sensitive\\ with\\ spaces --api-key sample-api-value,extra --verbose",
        'cli --password "prefix"sample-sensitive --api-key sample-api-value --verbose',
        "cli --password\nsample-sensitive --api-key\tsample-api-value --verbose",
        "cli \"--password\" sample-sensitive '--api-key' sample-api-value --verbose",
        "cli --password \\\n  sample-sensitive --api-key \\\n  sample-api-value --verbose",
        'cli --password "sample-\\\nsensitive" --api-key sample-api-value --verbose',
        "cli --token sample-sensitive --password sample-api-value --verbose",
        "cli --token=sample-sensitive --password=sample-api-value --verbose",
        "cli --token \"sample-sensitive with spaces\" --password='sample-api-value' --verbose",
        "cli --token sample-sensitive\\ with\\ spaces --password sample-api-value,extra --verbose",
    ],
)
def test_sensitive_cli_flags_are_redacted_without_changing_arguments(command):
    log = MagicMock()
    trajectory = _logger(log)
    args = {"command": command}
    trajectory.diagnostic("test", args_preview=args)
    preview = log.info.call_args.kwargs["args_preview"]
    assert "sample-sensitive" not in preview and "sample-api-value" not in preview
    assert "with" not in preview and "extra" not in preview
    assert "sensitive" not in preview
    assert "--verbose" in preview and REDACTED in preview
    assert args == {"command": command}


def test_cli_credential_crossing_the_retained_prefix_is_redacted():
    log = MagicMock()
    trajectory = _logger(log)
    trajectory.stderr(
        "a" * (PREVIEW_MAX_BYTES - 100)
        + ' --password "sample-sensitive '
        + "value " * PREVIEW_MAX_BYTES
    )
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "sample-sensitive" not in preview and "value" not in preview
    assert REDACTED in preview and preview.endswith(TRUNCATED)


def test_known_credential_crossing_the_retained_prefix_is_redacted():
    secret = "very-long-credential-" * PREVIEW_MAX_BYTES
    log = MagicMock()
    trajectory = _logger(log, {"DB_PASS": secret})
    trajectory.stderr("a" * (PREVIEW_MAX_BYTES - 50) + secret)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "very-long-credential" not in preview
    assert preview.endswith(TRUNCATED) and REDACTED in preview


@pytest.mark.parametrize("password_length", [1000, PREVIEW_MAX_BYTES * 4])
def test_url_userinfo_crossing_the_retained_prefix_is_redacted(password_length):
    log = MagicMock()
    trajectory = _logger(log)
    trajectory.stderr(
        "a" * (PREVIEW_MAX_BYTES - 150)
        + " https://user:"
        + "sensitive" * password_length
        + "@host/path"
    )
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "sensitive" not in preview and "user:" not in preview
    assert REDACTED in preview and preview.endswith(TRUNCATED)


def test_sensitive_property_names_are_also_scrubbed_for_known_credentials():
    log = MagicMock()
    trajectory = _logger(log, {"API_KEY": "sk-ant-key-secret"})
    trajectory.diagnostic("test", payload_preview={"sk-ant-key-secret": "metadata"})
    assert "sk-ant-key-secret" not in log.info.call_args.kwargs["payload_preview"]


def test_property_name_credential_crossing_the_retained_prefix_is_redacted():
    secret = "property-credential-" * 4
    log = MagicMock()
    trajectory = _logger(log, {USER_SECRET_KEYS_ENV_VAR: '["FOO"]', "FOO": secret})
    trajectory.diagnostic(
        "test", payload_preview={"x" * (PREVIEW_MAX_BYTES - 48) + secret: "metadata"}
    )
    preview = log.info.call_args.kwargs["payload_preview"]
    assert "property-credential" not in preview and REDACTED in preview


@pytest.mark.parametrize(
    "secret,value", [("12345678", 12345678), ("1.25", 1.25), ("true", True), ("null", None)]
)
def test_numeric_and_json_scalar_content_leaves_are_scrubbed(secret, value):
    log = MagicMock()
    trajectory = _logger(log, {USER_SECRET_KEYS_ENV_VAR: '["FOO"]', "FOO": secret})
    trajectory.diagnostic("test", payload_preview={"value": value})
    preview = log.info.call_args.kwargs["payload_preview"]
    assert secret not in preview and REDACTED in preview


@pytest.mark.parametrize("value", [["opaque-credential"], {"SAFE": "opaque-credential"}, [], {}])
def test_structured_preview_cannot_reconstruct_a_json_valued_credential(value):
    secret = json.dumps(value)
    log = MagicMock()
    trajectory = _logger(log, {USER_SECRET_KEYS_ENV_VAR: '["FOO"]', "FOO": secret})
    trajectory.diagnostic("test", args_preview={"value": value})
    preview = log.info.call_args.kwargs["args_preview"]
    assert secret not in preview and REDACTED in preview


def test_database_and_cloud_credentials_and_json_escaping_are_redacted():
    log = MagicMock()
    secrets = {
        "DATABASE_URL": "postgres://user:db-credential@host/db",
        "AWS_ACCESS_KEY_ID": "cloud-credential",
        "PRIVATE_KEY": 'private-line-1\nprivate-line-2"quoted"',
    }
    trajectory = _logger(log, secrets)
    text = " ".join(json.dumps(value)[1:-1] for value in secrets.values())
    trajectory.stderr(text)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    for part in ("db-credential", "cloud-credential", "private-line-1", "private-line-2"):
        assert part not in preview


def test_short_mcp_configuration_does_not_redact_text_or_identity_fields():
    log = MagicMock()
    trajectory = _logger(log, mcp_servers=({"env": {"DEBUG": "1", "ENABLED": "true"}},))
    trajectory.begin("m1", "session-1")
    trajectory.diagnostic(
        "test", call_id="call-1", parent_tool_use_id="parent-1", diagnostic_preview="1 item, true"
    )
    assert log.info.call_args.kwargs == {
        "message_id": "m1",
        "agent_session_id": "session-1",
        "call_id": "call-1",
        "parent_tool_use_id": "parent-1",
        "diagnostic_preview": "1 item, true",
    }


@pytest.mark.parametrize("env_key", ["FOO", "STRIPE_ACCOUNT"])
@pytest.mark.parametrize(
    "secret",
    [
        "xy",
        "\u00e9\u79d8\u5bc6",
        'private-line-one\nprivate-line-two"quoted"',
        "12345678",
        '["opaque-credential"]',
        '{"SAFE": "opaque-credential"}',
        "true",
        "null",
        "1.25",
    ],
)
def test_inventory_redacts_arbitrary_user_secrets_in_all_content_previews(env_key, secret):
    log = MagicMock()
    trajectory = _logger(log, {USER_SECRET_KEYS_ENV_VAR: json.dumps([env_key]), env_key: secret})
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    token = trajectory.begin("prompt", "native")
    text = "\n".join(
        ["unclassified " + secret, json.dumps(secret), json.dumps(secret, ensure_ascii=False)]
    )
    args = {"command": text}
    assistant = AssistantMessage(
        content=[TextBlock(text), ToolUseBlock(id="call", name="Bash", input=args)],
        model="m",
        message_id="assistant",
        session_id="native",
    )
    started = translator.translate(state, assistant, interrupted=False)
    trajectory.emit(started)
    completed = translator.translate(
        state,
        UserMessage(content=[ToolResultBlock(tool_use_id="call", content=text)]),
        interrupted=False,
    )
    trajectory.emit(completed)
    trajectory.stderr(text)
    trajectory.finish(TurnOutcome.ok(), token)

    previews = [
        value
        for call in log.info.call_args_list
        for key, value in call.kwargs.items()
        if key.endswith("_preview")
    ]
    assert trajectory.content_logging and len(previews) == 4
    for preview in previews:
        assert REDACTED in preview and CONTENT_OMITTED not in preview
        for part in (secret, *secret.splitlines()):
            for spelling in (
                part,
                json.dumps(part)[1:-1],
                json.dumps(part, ensure_ascii=False)[1:-1],
            ):
                assert spelling not in preview
    assert assistant.content[0].text == text
    assert args == {"command": text}
    assert next(event for event in started.events if event["type"] == "token")["content"] == text
    assert next(event for event in started.events if event["type"] == "tool_call")["args"] == args
    assert completed.events[0]["output"] == text


@pytest.mark.parametrize(
    "inventory",
    [
        {},
        {USER_SECRET_KEYS_ENV_VAR: ""},
        {USER_SECRET_KEYS_ENV_VAR: "["},
        {USER_SECRET_KEYS_ENV_VAR: "null"},
        {USER_SECRET_KEYS_ENV_VAR: '"FOO"'},
        {USER_SECRET_KEYS_ENV_VAR: '{"FOO": true}'},
        {USER_SECRET_KEYS_ENV_VAR: "[1]"},
        {USER_SECRET_KEYS_ENV_VAR: '["FOO", ["FOO"]]'},
        {USER_SECRET_KEYS_ENV_VAR: '["FOO", "UNSET"]'},
    ],
    ids=[
        "missing",
        "empty",
        "malformed-json",
        "null",
        "not-a-list",
        "object",
        "non-string-key",
        "nested-key",
        "missing-env-key",
    ],
)
def test_unavailable_inventory_omits_content_but_preserves_metadata(inventory):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(
        log, {"FOO": "opaque-content", "API_KEY": "known-credential", **inventory}, (), None
    )
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    token = trajectory.begin("prompt", "native")
    trajectory.emit(
        translator.translate(
            state,
            AssistantMessage(
                content=[
                    TextBlock("opaque-content"),
                    ToolUseBlock(id="call", name="Read", input={"file_path": "opaque-content"}),
                ],
                model="m",
                message_id="assistant",
                session_id="native",
            ),
            interrupted=False,
        )
    )
    trajectory.emit(
        translator.translate(
            state,
            UserMessage(
                content=[ToolResultBlock(tool_use_id="call", content="opaque-content")],
                parent_tool_use_id="parent",
            ),
            interrupted=False,
        )
    )
    result = translator.translate(
        state,
        ResultMessage(
            subtype="error_during_execution",
            duration_ms=100,
            duration_api_ms=50,
            is_error=True,
            num_turns=1,
            session_id="native",
            total_cost_usd=0.1,
            usage={"input_tokens": 100},
            result="opaque-content",
        ),
        interrupted=False,
    )
    trajectory.emit(result)
    trajectory.diagnostic("test.exception", exc=RuntimeError("opaque-content"))
    trajectory.stderr("opaque-content")
    trajectory.finish(result.outcome, token)

    records = {call.args[0]: call.kwargs for call in log.info.call_args_list}
    assert not trajectory.content_logging
    previews = [
        value
        for record in records.values()
        for key, value in record.items()
        if key.endswith("_preview") or key == "error_message"
    ]
    assert len(previews) == 7 and all(value == CONTENT_OMITTED for value in previews)
    assert records["claude.tool.started"]["tool"] == "Read"
    assert records["claude.tool.started"]["call_id"] == "call"
    assert records["claude.tool.completed"]["call_id"] == "call"
    assert records["claude.tool.completed"]["parent_tool_use_id"] == "parent"
    assert records["claude.assistant.message"]["assistant_message_id"] == "assistant"
    assert records["test.exception"]["error_type"] == "RuntimeError"
    finish = records["claude.turn.failed"]
    assert finish["message_id"] == "prompt" and finish["agent_session_id"] == "native"
    assert finish["sdk_status"] == "error_during_execution" and finish["sdk_is_error"]
    assert finish["sdk_duration_ms"] == 100 and finish["sdk_duration_api_ms"] == 50
    assert finish["total_cost_usd"] == 0.1 and finish["tokens"] == {"input": 100}
    assert "opaque-content" not in json.dumps(records)
    assert trajectory._turn.get() is None


def test_raised_exception_logs_redacted_message_and_safe_frame_metadata_only():
    log = MagicMock()
    trajectory = _logger(
        log,
        {USER_SECRET_KEYS_ENV_VAR: '["FOO"]', "FOO": "exception-message-credential"},
    )

    def raise_secret_source():
        raise RuntimeError("exception-message-credential")

    try:
        raise_secret_source()
    except RuntimeError as exc:
        trajectory.diagnostic("test.exception", level="error", exc=exc)
        frame = exc.__traceback__.tb_next
        expected_frame = f", line {frame.tb_lineno}, in raise_secret_source"

    log.error.assert_called_once()
    record = log.error.call_args.kwargs
    assert record["error_type"] == "RuntimeError"
    assert record["error_message"] == REDACTED
    stack = record["error_stack"]
    assert "test_claude_logging.py" in stack and expected_frame in stack
    assert all(line.startswith("File ") and ", line " in line for line in stack.splitlines())
    assert "raise RuntimeError" not in stack and "raise_secret_source()" not in stack
    assert "exception-message-credential" not in json.dumps(record)
    assert "Traceback (most recent call last)" not in stack


@pytest.mark.parametrize("failure", ["logger", "serialization"])
def test_one_bad_record_does_not_suppress_later_records_or_typed_result(failure):
    log = MagicMock()
    trajectory = _logger(log)
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
    ["a" * 1_000_000, list(range(100_000)), {str(index): "value" for index in range(10_000)}],
)
def test_large_payload_processing_and_output_are_bounded(value):
    log = MagicMock()
    trajectory = _logger(log)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES
    assert TRUNCATED in preview


def test_deep_or_cyclic_structures_are_bounded():
    value = {"nested": {}}
    value["nested"] = value
    log = MagicMock()
    trajectory = _logger(log)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert TRUNCATED in preview and len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES


def test_width_at_the_depth_boundary_still_spends_the_node_budget():
    trajectory = _logger(MagicMock())
    value = list(range(100_000))
    for _ in range(PREVIEW_MAX_DEPTH):
        value = [value]
    safe = trajectory._redact(value, [PREVIEW_MAX_NODES])
    for _ in range(PREVIEW_MAX_DEPTH):
        safe = safe[0]
    assert len(safe) <= PREVIEW_MAX_NODES and TRUNCATED in safe


async def test_interleaved_turns_keep_identity_deduplication_and_result_fields_isolated():
    log = MagicMock()
    trajectory = _logger(log)
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
    trajectory = _logger(log)
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
