"""Claude harness trajectory logging against a scripted fake SDK client."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    RateLimitEvent,
    RateLimitInfo,
    SystemMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from sandbox_runtime.harness import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.claude_logging import PREVIEW_MAX_BYTES, TRUNCATED
from sandbox_runtime.log_config import JSONFormatter, get_logger
from tests.claude_fakes import (
    Harness,
    _result,
    _run,
    _stream,
    _text_delta,
)

if TYPE_CHECKING:
    from pathlib import Path


def _trajectory_records(caplog, event: str | None = None) -> list[dict[str, Any]]:
    formatter = JSONFormatter()
    return [
        json.loads(formatter.format(record))
        for record in caplog.records
        if record.name == "claude-trajectory-test"
        and (event is None or record.getMessage() == event)
    ]


@pytest.fixture
def trajectory_log(caplog):
    caplog.set_level(logging.INFO, logger="claude-trajectory-test")
    return get_logger("claude-trajectory-test", sandbox_id="sb-test", session_id="oi-session")


class TestTrajectoryLogging:
    async def test_tool_logs_are_correlated_without_changing_wire_payloads(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        args = {"command": "ls", "nested": {"apiKey": "private-value"}}
        turn = [
            AssistantMessage(
                content=[
                    ToolUseBlock(id="tu_ok", name="Bash", input=args),
                    ToolUseBlock(id="tu_error", name="Read", input={"file_path": "missing"}),
                ],
                model="m",
                session_id="native-session",
            ),
            UserMessage(content=[ToolResultBlock(tool_use_id="tu_ok", content="a.txt\nb.txt")]),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="tu_error", content="missing", is_error=True)]
            ),
            _result(0.2, session_id="native-session"),
        ]
        h = Harness(tmp_path, turns=[turn], log=trajectory_log)
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        tools = [event for event in events if event["type"] == "tool_call"]
        assert tools == [
            {
                "type": "tool_call",
                "tool": "Bash",
                "args": args,
                "callId": "tu_ok",
                "status": "running",
                "output": "",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Read",
                "args": {"file_path": "missing"},
                "callId": "tu_error",
                "status": "running",
                "output": "",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Bash",
                "args": args,
                "callId": "tu_ok",
                "status": "completed",
                "output": "a.txt\nb.txt",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Read",
                "args": {"file_path": "missing"},
                "callId": "tu_error",
                "status": "error",
                "output": "missing",
                "messageId": "m1",
            },
        ]
        starts = _trajectory_records(caplog, "claude.tool.started")
        (completed,) = _trajectory_records(caplog, "claude.tool.completed")
        (failed,) = _trajectory_records(caplog, "claude.tool.failed")
        assert [record["call_id"] for record in starts] == ["tu_ok", "tu_error"]
        assert json.loads(starts[0]["args_preview"]) == args
        assert completed["call_id"] == "tu_ok" and completed["output_preview"] == "a.txt\nb.txt"
        assert failed["call_id"] == "tu_error" and failed["status"] == "error"
        for record in [*starts, completed, failed]:
            assert record["level"] == "info"
            assert record["sandbox_id"] == "sb-test" and record["session_id"] == "oi-session"
            assert record["agent_session_id"] == "native-session" and record["message_id"] == "m1"

    async def test_subagent_tools_and_lifecycle_keep_parent_ids_without_collecting_text(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        usage = {"total_tokens": 25, "tool_uses": 2, "duration_ms": 100}
        turn = [
            AssistantMessage(
                content=[ToolUseBlock(id="parent", name="Agent", input={"prompt": "inspect"})],
                model="m",
            ),
            TaskStartedMessage(
                subtype="task_started",
                data={"uncollected": "raw-data"},
                task_id="task-1",
                description="Inspect files",
                uuid="u",
                session_id="native",
                tool_use_id="parent",
                task_type="local_agent",
            ),
            AssistantMessage(
                content=[
                    TextBlock("uncollected-child-text"),
                    ThinkingBlock(thinking="uncollected-reasoning", signature="sig"),
                    ToolUseBlock(id="child", name="Read", input={"file_path": "f"}),
                ],
                model="m",
                parent_tool_use_id="parent",
                session_id="native",
            ),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="child", content="ok")],
                parent_tool_use_id="parent",
            ),
            TaskProgressMessage(
                subtype="task_progress",
                data={},
                task_id="task-1",
                description="uncollected-progress-text",
                usage=usage,
                uuid="p",
                session_id="native",
                last_tool_name="Read",
            ),
            TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id="task-1",
                status="failed",
                patch={"error": "read failed", "result": "uncollected-task-result"},
            ),
            TaskNotificationMessage(
                subtype="task_notification",
                data={},
                task_id="task-1",
                status="completed",
                output_file="/tmp/result",
                summary="uncollected-summary",
                uuid="n",
                session_id="native",
                tool_use_id="parent",
                usage=usage,
            ),
            _result(0.1, session_id="native"),
        ]
        h = Harness(tmp_path, turns=[turn], log=trajectory_log)
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        tools = [event for event in events if event["type"] == "tool_call"]
        assert tools[0]["tool"] == "task"
        assert all(event["taskCallId"] == "parent" for event in tools[1:])
        records = _trajectory_records(caplog)
        nested = [record for record in records if record.get("call_id") == "child"]
        assert [record["status"] for record in nested] == ["running", "completed"]
        lifecycle = [record for record in records if record["event"].startswith("claude.task.")]
        assert len(lifecycle) == 4
        assert all(record["parent_tool_use_id"] == "parent" for record in nested + lifecycle)
        assert all(record["task_id"] == "task-1" for record in lifecycle)
        assert lifecycle[1]["total_tokens"] == 25 and lifecycle[1]["tool_uses"] == 2
        assert lifecycle[2]["status"] == "failed" and lifecycle[2]["error_preview"] == "read failed"
        assert lifecycle[3]["status"] == "completed" and lifecycle[3]["duration_ms"] == 100
        assert "uncollected" not in json.dumps(records)
        assert not any(event["type"] == "token" for event in events)

    async def test_completed_assistant_text_is_logged_once_not_per_delta(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        message = AssistantMessage(
            content=[
                TextBlock("Hello"),
                ThinkingBlock(thinking="private-thought", signature="sig"),
            ],
            model="m",
            message_id="msg-1",
        )
        h = Harness(
            tmp_path,
            turns=[
                [
                    _stream("message_start", message={"id": "msg-1"}),
                    _text_delta("Hel"),
                    _text_delta("lo"),
                    message,
                    message,
                    _result(0.0),
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        assert [event["content"] for event in events if event["type"] == "token"] == [
            "Hel",
            "Hello",
        ]
        (record,) = _trajectory_records(caplog, "claude.assistant.message")
        assert record["text_preview"] == "Hello" and record["assistant_message_id"] == "msg-1"
        assert "private-thought" not in json.dumps(_trajectory_records(caplog))

    @pytest.mark.parametrize("subtype,is_error", [("success", False), ("error_max_turns", True)])
    async def test_turn_outcome_duration_usage_and_cost(
        self, tmp_path: Path, trajectory_log, caplog, subtype, is_error
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [_result(0.1)],
                [
                    _result(
                        0.35,
                        subtype=subtype,
                        is_error=is_error,
                        errors=["turn failed"] if is_error else None,
                        usage={
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "cache_creation_input_tokens": 3,
                            "uncollected": "raw-usage",
                        },
                    )
                ],
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        events, outcome = await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        records = [
            record
            for record in _trajectory_records(caplog)
            if record["event"].startswith("claude.turn.")
        ]
        assert len(records) == 2
        record = records[-1]
        assert record["status"] == ("failed" if is_error else "completed")
        assert record["message_id"] == "m2" and record["agent_session_id"] == "sess"
        assert record["duration_s"] >= 0
        assert record["sdk_duration_ms"] == 10 and record["sdk_duration_api_ms"] == 5
        assert record["num_turns"] == 1 and record["sdk_status"] == subtype
        assert record["message_cost_usd"] == pytest.approx(0.25)
        assert record["total_cost_usd"] == 0.35
        assert record["tokens"] == {"input": 10, "output": 5, "cache": {"write": 3}}
        assert outcome.success is not is_error
        assert next(event for event in events if event["type"] == "step_finish")[
            "messageCostUsd"
        ] == pytest.approx(0.25)
        assert "uncollected" not in json.dumps(records)

    async def test_stderr_callback_is_supported_and_stays_session_scoped_on_reused_client(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[[_result(0.1)], [_result(0.2)]],
            log=trajectory_log,
            client_kwargs={"stderr_on_connect": "startup diagnostic"},
        )
        await h.harness.open()
        await h.harness.create_session()
        native_id = h.harness.session_id
        await _run(h.harness)
        assert callable(ClaudeAgentOptions(**h.client.options).stderr)

        async def emit(_event):
            h.client.options["stderr"]("second prompt diagnostic")

        await h.harness.run_prompt(HarnessPrompt(message_id="m2", text="next"), emit)
        records = _trajectory_records(caplog, "claude.sdk.stderr")
        assert len(h.clients) == 1
        assert all("message_id" not in record for record in records)
        assert [record["diagnostic_preview"] for record in records] == [
            "startup diagnostic",
            "second prompt diagnostic",
        ]
        assert records[0]["agent_session_id"] == native_id
        assert records[1]["agent_session_id"] == "sess"

    async def test_raw_bounded_unicode_previews_leave_inputs_and_session_events_untouched(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        text = (
            "sentinel\nAuthorization: Bearer raw-token\napi_key=raw-key\n"
            + "\u00e9\U0001f680" * PREVIEW_MAX_BYTES
        )
        args = {
            "apiKey": "raw-key",
            "nested": {"password": "raw-password"},
            "command": text,
        }
        original_args = json.dumps(args, ensure_ascii=False)
        assistant = AssistantMessage(
            content=[TextBlock(text), ToolUseBlock(id="tu", name="Bash", input=args)],
            model="m",
        )
        result = UserMessage(content=[ToolResultBlock(tool_use_id="tu", content=text)])
        h = Harness(
            tmp_path,
            turns=[[assistant, result, _result(0.1)]],
            log=trajectory_log,
            client_kwargs={"stderr_on_connect": text},
        )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        assert next(event for event in events if event["type"] == "tool_call")["args"] == args
        assert (
            next(event for event in events if event.get("status") == "completed")["output"] == text
        )
        assert next(event for event in events if event["type"] == "token")["content"] == text
        assert assistant.content[0].text == text and assistant.content[1].input is args
        assert result.content[0].content == text
        assert json.dumps(args, ensure_ascii=False) == original_args
        records = _trajectory_records(caplog)
        previews = [
            value for record in records for key, value in record.items() if key.endswith("_preview")
        ]
        assert len(previews) == 4
        assert all(len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES for preview in previews)
        assert all(preview.endswith(TRUNCATED) for preview in previews)
        assert all("sentinel" in preview and "raw-key" in preview for preview in previews)
        assert all("Authorization: Bearer raw-token" in preview for preview in previews)
        assert all("\u00e9\U0001f680" in preview for preview in previews)
        (started,) = _trajectory_records(caplog, "claude.tool.started")
        assert '"apiKey": "raw-key"' in started["args_preview"]
        assert '"password": "raw-password"' in started["args_preview"]
        for record in caplog.records:
            line = JSONFormatter().format(record)
            assert "\n" not in line
            json.loads(line)

    async def test_compaction_and_provider_diagnostics_are_allowlisted(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    SystemMessage(
                        subtype="compact_boundary",
                        data={
                            "compact_metadata": {
                                "trigger": "auto",
                                "pre_tokens": 5000,
                                "uncollected": "configuration",
                            }
                        },
                    ),
                    RateLimitEvent(
                        rate_limit_info=RateLimitInfo(
                            status="rejected", rate_limit_type="five_hour"
                        ),
                        uuid="u",
                        session_id="native",
                    ),
                    _result(None),
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        (record,) = _trajectory_records(caplog, "claude.context.compacted")
        assert record["trigger"] == "auto" and record["pre_tokens"] == 5000
        warnings = _trajectory_records(caplog, "claude.provider.warning")
        assert len(warnings) == 2 and "rejected" in warnings[0]["diagnostic_preview"]
        assert "no cost" in warnings[1]["diagnostic_preview"]
        assert "uncollected" not in json.dumps(_trajectory_records(caplog))
        assert events[0] == {"type": "context_compacted", "messageId": "m1"}

    async def test_task_parent_ids_survive_prompt_boundaries(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    TaskStartedMessage(
                        subtype="task_started",
                        data={},
                        task_id="task-late",
                        description="Inspect",
                        uuid="u",
                        session_id="sess",
                        tool_use_id="parent-late",
                    ),
                    _result(0.1),
                ],
                [
                    TaskUpdatedMessage(
                        subtype="task_updated",
                        data={},
                        task_id="task-late",
                        patch={"status": "completed"},
                        status="completed",
                    ),
                    _result(0.2),
                ],
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        (record,) = _trajectory_records(caplog, "claude.task.updated")
        assert record["parent_tool_use_id"] == "parent-late" and record["message_id"] == "m2"

    @pytest.mark.parametrize("kind", ["notification", "updated"])
    async def test_injected_terminal_task_messages_still_evict_parent_mappings(
        self, tmp_path: Path, trajectory_log, caplog, kind
    ) -> None:
        if kind == "notification":
            terminal = TaskNotificationMessage(
                subtype="task_notification",
                data={},
                task_id="task",
                status="completed",
                output_file="file",
                summary="injected-summary",
                uuid="n",
                session_id="sess",
            )
        else:
            terminal = TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id="task",
                patch={"status": "completed"},
                status="completed",
            )
        h = Harness(
            tmp_path,
            log=trajectory_log,
            turns=[
                [
                    TaskStartedMessage(
                        subtype="task_started",
                        data={},
                        task_id="task",
                        description="inspect",
                        uuid="u",
                        session_id="sess",
                        tool_use_id="parent",
                    ),
                    _result(0.1),
                ],
                [
                    UserMessage(content="injected content", origin={"kind": "task-notification"}),
                    terminal,
                    _result(0.15, origin={"kind": "task-notification"}),
                    _result(0.2),
                ],
            ],
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        assert h.harness._translator._task_parents == {"task": "parent"}
        events, outcome = await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        assert outcome.success and not h.harness._translator._task_parents
        assert [event["type"] for event in events] == ["step_finish"]
        assert not _trajectory_records(caplog, "claude.task." + kind)
        assert "injected-summary" not in json.dumps(_trajectory_records(caplog))

    @pytest.mark.parametrize("failure", ["logger", "serialization", "cyclic"])
    async def test_logging_failures_do_not_fail_the_turn(self, tmp_path: Path, failure) -> None:
        log = MagicMock()
        if failure == "logger":
            log.info.side_effect = RuntimeError("logging handler failed")
        args: dict[str, Any] = {"command": "ls"}
        if failure == "serialization":
            args["unserializable"] = object()
        elif failure == "cyclic":
            args["nested"] = args
        h = Harness(
            tmp_path,
            turns=[
                [
                    SystemMessage(subtype="init", data={}),
                    AssistantMessage(
                        content=[
                            TextBlock("hello"),
                            ToolUseBlock(id="tu", name="Bash", input=args),
                        ],
                        model="m",
                    ),
                    UserMessage(content=[ToolResultBlock(tool_use_id="tu", content="ok")]),
                    _result(0.1),
                ]
            ],
            log=log,
            client_kwargs={"stderr_on_connect": "diagnostic"},
        )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success and outcome.message_cost_usd == 0.1
        assert [event["type"] for event in events] == [
            "step_start",
            "token",
            "tool_call",
            "tool_call",
            "step_finish",
        ]
        if failure != "logger":
            assert "claude.turn.completed" in [call.args[0] for call in log.info.call_args_list]

    async def test_tool_logs_precede_failed_delivery(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[
                            ToolUseBlock(id="one", name="Read", input={"file_path": "a"}),
                            ToolUseBlock(id="two", name="Read", input={"file_path": "b"}),
                        ],
                        model="m",
                    )
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()

        async def emit(_event):
            assert [
                record["call_id"] for record in _trajectory_records(caplog, "claude.tool.started")
            ] == ["one", "two"]
            raise RuntimeError("control plane disconnected")

        outcome = await h.harness.run_prompt(HarnessPrompt(message_id="m1", text="hi"), emit)
        assert not outcome.success
        (record,) = _trajectory_records(caplog, "claude.turn.failed")
        assert "control plane disconnected" in record["error_preview"]

    @pytest.mark.parametrize(
        "failure", ["stream_end", "connect_error", "invalid_model", "inactivity"]
    )
    async def test_failures_without_sdk_results_are_logged(
        self, tmp_path: Path, trajectory_log, caplog, failure
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[[]],
            log=trajectory_log,
            client_kwargs={
                "fail_connect": failure == "connect_error",
                "hang": failure == "inactivity",
            },
            limits=PromptLimits(
                inactivity_timeout_seconds=0.01,
                prompt_max_duration_seconds=5.0,
                prompt_cleanup_timeout_seconds=1.0,
            ),
        )
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await _run(
            h.harness,
            HarnessPrompt(
                message_id="m1",
                text="hi",
                model="openai/gpt-5" if failure == "invalid_model" else None,
            ),
        )
        assert not outcome.success
        (record,) = _trajectory_records(caplog, "claude.turn.failed")
        assert record["error_preview"] == outcome.error
        assert record["message_id"] == "m1" and record["duration_s"] >= 0
        assert "sdk_status" not in record

    async def test_cancellation_is_logged_and_still_propagates(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(tmp_path, turns=[[]], log=trajectory_log, client_kwargs={"hang": True})
        await h.harness.open()
        await h.harness.create_session()
        task = asyncio.create_task(_run(h.harness))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        (record,) = _trajectory_records(caplog, "claude.turn.cancelled")
        assert record["status"] == "cancelled" and record["message_id"] == "m1"
