"""Security and processing bounds for Claude-only trajectory previews."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ConversationResetMessage,
    ResultMessage,
    SystemMessage,
    TaskNotificationMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
)

from sandbox_runtime.harness.base import TurnOutcome
from sandbox_runtime.harness.claude_logging import (
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_DEPTH,
    PREVIEW_MAX_NODES,
    REDACTED,
    TRUNCATED,
    ClaudeTrajectoryLogger,
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
        "https://user:sensitive@host/path",
    ],
)
def test_sensitive_keys_and_free_text_assignments_are_redacted(value):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
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
    ],
)
def test_sensitive_cli_flags_are_redacted_without_changing_arguments(command):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
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
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
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
    trajectory = ClaudeTrajectoryLogger(log, {"DB_PASS": secret}, (), None)
    trajectory.stderr("a" * (PREVIEW_MAX_BYTES - 50) + secret)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "very-long-credential" not in preview
    assert preview.endswith(TRUNCATED) and REDACTED in preview


@pytest.mark.parametrize("password_length", [1000, PREVIEW_MAX_BYTES * 4])
def test_url_userinfo_crossing_the_retained_prefix_is_redacted(password_length):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
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
    trajectory = ClaudeTrajectoryLogger(log, {"API_KEY": "sk-ant-key-secret"}, (), None)
    trajectory.diagnostic("test", payload_preview={"sk-ant-key-secret": "metadata"})
    assert "sk-ant-key-secret" not in log.info.call_args.kwargs["payload_preview"]


def test_database_and_cloud_credentials_and_json_escaping_are_redacted():
    log = MagicMock()
    secrets = {
        "DATABASE_URL": "postgres://user:db-credential@host/db",
        "AWS_ACCESS_KEY_ID": "cloud-credential",
        "PRIVATE_KEY": 'private-line-1\nprivate-line-2"quoted"',
    }
    trajectory = ClaudeTrajectoryLogger(log, secrets, (), None)
    text = " ".join(json.dumps(value)[1:-1] for value in secrets.values())
    trajectory.stderr(text)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    for part in ("db-credential", "cloud-credential", "private-line-1", "private-line-2"):
        assert part not in preview


def test_short_mcp_configuration_does_not_redact_text_or_identity_fields():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(
        log, {}, ({"env": {"DEBUG": "1", "ENABLED": "true"}},), None
    )
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


@pytest.mark.parametrize(
    "value",
    ["a" * 1_000_000, list(range(100_000)), {str(index): "value" for index in range(10_000)}],
)
def test_large_payload_processing_and_output_are_bounded(value):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES
    assert TRUNCATED in preview


def test_deep_or_cyclic_structures_are_bounded():
    value = {"nested": {}}
    value["nested"] = value
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert TRUNCATED in preview and len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES


def test_width_at_the_depth_boundary_still_spends_the_node_budget():
    trajectory = ClaudeTrajectoryLogger(MagicMock(), {}, (), None)
    value = list(range(100_000))
    for _ in range(PREVIEW_MAX_DEPTH):
        value = [value]
    safe = trajectory._redact(value, [PREVIEW_MAX_NODES])
    for _ in range(PREVIEW_MAX_DEPTH):
        safe = safe[0]
    assert len(safe) <= PREVIEW_MAX_NODES and TRUNCATED in safe


async def test_interleaved_turns_keep_identity_deduplication_and_result_fields_isolated():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    a_started = asyncio.Event()
    b_ready = asyncio.Event()
    a_finished = asyncio.Event()

    def log_messages(name, cost, duration_ms):
        trajectory.message(
            AssistantMessage(
                content=[TextBlock("same assistant text")],
                model="m",
                message_id="same-id",
                session_id="native",
            ),
            [
                {
                    "type": "tool_call",
                    "tool": "Read",
                    "callId": name,
                    "status": "running",
                    "args": {"file_path": name},
                }
            ],
        )
        trajectory.message(
            ResultMessage(
                subtype="success",
                duration_ms=duration_ms,
                duration_api_ms=duration_ms,
                is_error=False,
                num_turns=1,
                session_id="native",
                total_cost_usd=cost,
            ),
            [{"type": "step_finish", "tokens": {"input": duration_ms}}],
        )

    async def first():
        token = trajectory.begin("A", "native")
        a_started.set()
        await b_ready.wait()
        log_messages("A", 0.1, 100)
        trajectory.finish(TurnOutcome.ok(message_cost_usd=0.1), token)
        assert trajectory._turn.get() is None
        a_finished.set()

    async def second():
        await a_started.wait()
        token = trajectory.begin("B", "native")
        log_messages("B", 0.2, 200)
        trajectory.stderr("overlapping prompts")
        b_ready.set()
        await a_finished.wait()
        trajectory.diagnostic("test.after_other_turn_finished")
        trajectory.finish(TurnOutcome.ok(message_cost_usd=0.2), token)
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
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
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


@pytest.mark.parametrize(
    "kind,status",
    [
        ("notification", "completed"),
        ("notification", "failed"),
        ("notification", "stopped"),
        ("updated", "completed"),
        ("updated", "failed"),
        ("updated", "killed"),
    ],
)
def test_terminal_tasks_are_logged_with_the_parent_then_evicted(kind, status):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.begin("prompt", "native")
    trajectory.message(
        TaskStartedMessage(
            subtype="task_started",
            data={},
            task_id="task",
            description="inspect",
            uuid="u",
            session_id="native",
            tool_use_id="parent",
        ),
        [],
    )
    if kind == "notification":
        terminal = TaskNotificationMessage(
            subtype="task_notification",
            data={},
            task_id="task",
            status=status,
            output_file="file",
            summary="summary",
            uuid="n",
            session_id="native",
        )
    else:
        terminal = TaskUpdatedMessage(
            subtype="task_updated", data={}, task_id="task", patch={"status": status}, status=status
        )
    trajectory.message(terminal, [])
    assert log.info.call_args.kwargs["parent_tool_use_id"] == "parent"
    assert not trajectory._task_parents


@pytest.mark.parametrize("reset", ["explicit", "conversation", "native_change"])
def test_session_resets_clear_stale_parent_mappings(reset):
    trajectory = ClaudeTrajectoryLogger(MagicMock(), {}, (), None)
    trajectory.begin("prompt", "native")
    trajectory.message(
        TaskStartedMessage(
            subtype="task_started",
            data={},
            task_id="task",
            description="inspect",
            uuid="u",
            session_id="native",
            tool_use_id="parent",
        ),
        [],
    )
    if reset == "explicit":
        trajectory.reset_session("new-native")
    elif reset == "conversation":
        trajectory.message(
            ConversationResetMessage(
                new_conversation_id="new-conversation", uuid="r", session_id="native"
            ),
            [],
        )
    else:
        trajectory.message(SystemMessage(subtype="init", data={"session_id": "new-native"}), [])
    assert not trajectory._task_parents
