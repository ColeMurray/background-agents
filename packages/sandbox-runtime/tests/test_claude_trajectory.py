"""Diagnostic projection regressions, separate from the harness execution contract."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
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

from sandbox_runtime.harness import HarnessPrompt
from sandbox_runtime.harness.base import TurnOutcome
from sandbox_runtime.harness.claude_trajectory import observe_events, observe_message, observe_turn
from sandbox_runtime.log_config import JSONFormatter, get_logger
from sandbox_runtime.log_safety import REDACTED, TRUNCATED
from tests.test_claude_harness import (
    FakeCredentialClient,
    Harness,
    Issued,
    _result,
    _run,
    _stream,
    _text_delta,
)

if TYPE_CHECKING:
    from pathlib import Path


class TestTrajectoryLogging:
    async def test_stderr_uses_client_scope_and_redacts_brokered_secret(self, tmp_path, caplog):
        h = Harness(
            tmp_path,
            turns=[[_result(0.1)]],
            oauth_managed=True,
            credential_client=FakeCredentialClient(Issued("opaque-brokered-credential")),
        )
        h.harness.log = get_logger("stderr-scope", session_id="session", sandbox_id="sb")
        await h.harness.open()
        await h.harness.create_session()
        original_id = h.harness.session_id
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        callback = h.client.options["stderr"]
        with caplog.at_level(logging.INFO, logger="stderr-scope"):
            await _run(h.harness)
            h.harness.session_id = "rotated-native-session"
            callback("late stderr opaque-brokered-credential")
        entry = next(
            json.loads(JSONFormatter().format(record))
            for record in caplog.records
            if record.getMessage() == "claude.stderr"
        )
        assert entry["client_agent_session_id"] == original_id
        assert "message_id" not in entry and "agent_session_id" not in entry
        assert entry["session_id"] == "session" and entry["sandbox_id"] == "sb"
        assert entry["output"] == f"late stderr {REDACTED}"

    async def test_stderr_never_borrows_an_overlapping_prompt_id(self, tmp_path):
        h = Harness(tmp_path)
        await h.harness.open()
        await h.harness.create_session()
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        callback = h.client.options["stderr"]
        entered = {name: asyncio.Event() for name in ("A", "B")}
        released = {name: asyncio.Event() for name in ("A", "B")}

        async def run(prompt, emit):
            entered[prompt.message_id].set()
            await released[prompt.message_id].wait()
            return TurnOutcome.ok()

        h.harness._run_prompt = run
        tasks = [
            asyncio.create_task(
                h.harness.run_prompt(HarnessPrompt(message_id=name, text="x"), MagicMock())
            )
            for name in ("A", "B")
        ]
        await asyncio.gather(*(event.wait() for event in entered.values()))
        callback("both prompts active")
        released["A"].set()
        await tasks[0]
        callback("B still active")
        released["B"].set()
        await tasks[1]
        entries = [
            call.kwargs
            for call in h.harness.log.info.call_args_list
            if call.args[0] == "claude.stderr"
        ]
        assert len(entries) == 2 and all("message_id" not in entry for entry in entries)

    @pytest.mark.parametrize(
        "usage",
        ["bad", ["bad"], {"duration_ms": "bad", "tool_uses": True, "total_tokens": float("inf")}],
    )
    async def test_malformed_task_usage_cannot_fail_a_healthy_turn(self, tmp_path, usage):
        message = TaskProgressMessage(
            subtype="task_progress",
            data={},
            task_id="task",
            description="private",
            usage=usage,
            uuid="u",
            session_id="s",
        )
        h = Harness(tmp_path, turns=[[message, _result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success and not h.harness._needs_reconnect
        assert [event["type"] for event in events] == ["step_finish"]

    @pytest.mark.parametrize("patch", ["bad", ["bad"], {"status": ["malformed"]}])
    async def test_malformed_task_patch_cannot_fail_a_healthy_turn(self, tmp_path, patch):
        message = TaskUpdatedMessage(subtype="task_updated", data={}, task_id="task", patch=patch)
        h = Harness(tmp_path, turns=[[message, _result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await _run(h.harness)
        assert outcome.success and not h.harness._needs_reconnect

    async def test_malformed_result_diagnostic_numbers_do_not_change_success(self, tmp_path):
        result = _result(0.1)
        result.duration_ms = "bad"
        result.duration_api_ms = float("nan")
        result.num_turns = ["bad"]
        h = Harness(tmp_path, turns=[[result]])
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await _run(h.harness)
        assert outcome.success and not h.harness._needs_reconnect
        entry = next(
            call.kwargs
            for call in h.harness.log.info.call_args_list
            if call.args[0] == "claude.result"
        )
        assert all(
            key not in entry for key in ("duration_seconds", "api_duration_seconds", "num_turns")
        )

    async def test_cancelled_result_and_turn_end_have_the_same_outcome(self, tmp_path):
        h = Harness(tmp_path, turns=[[_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        client = await h.harness._ensure_client("claude-sonnet-4-6", None)
        query = client.query

        async def interrupted_query(prompt, session_id="default"):
            await query(prompt, session_id)
            h.harness._interrupted = True

        h.client.query = interrupted_query
        _, outcome = await _run(h.harness)
        assert outcome.cancelled
        entries = [
            call.kwargs
            for call in h.harness.log.info.call_args_list
            if call.args[0] in ("claude.result", "claude.turn_end")
        ]
        assert len(entries) == 2 and all(entry["outcome"] == "cancelled" for entry in entries)

    async def test_agent_tool_logs_only_metadata_and_preserves_ui_payloads(self, tmp_path):
        args = {"prompt": "private child prompt", "description": "private child description"}
        output = "private child summary /private/output/path"
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[ToolUseBlock(id="agent", name="Agent", input=args)], model="m"
                    ),
                    UserMessage(content=[ToolResultBlock(tool_use_id="agent", content=output)]),
                    _result(0.1),
                ]
            ],
        )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        entries = [
            call.kwargs
            for call in h.harness.log.info.call_args_list
            if call.args[0] == "claude.tool_call"
        ]
        assert len(entries) == 2 and all(entry["tool"] == "task" for entry in entries)
        assert all("args_preview" not in entry and "output" not in entry for entry in entries)
        rendered = str(h.harness.log.method_calls)
        for private_text in (*args.values(), output):
            assert private_text not in rendered
        wire = [event for event in events if event["type"] == "tool_call"]
        assert wire[0]["args"] == args and wire[1]["output"] == output and outcome.success

    def test_entire_projection_boundary_handles_malicious_mapping_and_events(self):
        class BrokenMapping(dict):
            def get(self, *args):
                raise RuntimeError("bad diagnostic mapping")

        log = MagicMock()
        task = TaskProgressMessage(
            subtype="task_progress",
            data={},
            task_id="task",
            description="private",
            usage=BrokenMapping(),
            uuid="u",
            session_id="s",
        )
        observe_message(log, task, agent_session_id="s", message_id="m")
        observe_events(
            log,
            [
                BrokenMapping(),
                {},
                {"type": "tool_call", "callId": "valid", "tool": "Read", "status": "running"},
            ],
            agent_session_id="s",
            message_id="m",
        )
        assert log.info.call_args.kwargs["call_id"] == "valid"

    def test_bad_exception_string_cannot_replace_original_turn_exception(self):
        class BadError(Exception):
            def __str__(self):
                raise RuntimeError("bad exception diagnostic")

        failure = BadError()
        with (
            pytest.raises(BadError) as caught,
            observe_turn(MagicMock(), agent_session_id="s", message_id="m"),
        ):
            raise failure
        assert caught.value is failure

    async def test_real_logger_accepts_tool_arguments_and_preserves_context(self, tmp_path, caplog):
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[
                            ToolUseBlock(
                                id="tool-real",
                                name="Bash",
                                input={"command": "ls", "api_key": "unknown-key"},
                            )
                        ],
                        model="m",
                    ),
                    UserMessage(
                        content=[ToolResultBlock(tool_use_id="tool-real", content="x" * 4000)]
                    ),
                    _result(0.1),
                ]
            ],
        )
        h.harness.log = get_logger("claude-real-log", session_id="session", sandbox_id="sb")
        await h.harness.open()
        await h.harness.create_session()
        with caplog.at_level(logging.INFO, logger="claude-real-log"):
            _, outcome = await _run(h.harness)
        entries = [json.loads(JSONFormatter().format(record)) for record in caplog.records]
        tool = next(entry for entry in entries if entry["event"] == "claude.tool_call")
        assert tool["args_preview"] == {"command": "ls", "api_key": REDACTED}
        assert tool["call_id"] == "tool-real" and tool["message_id"] == "m1"
        assert tool["session_id"] == "session" and tool["sandbox_id"] == "sb"
        result = next(
            entry
            for entry in entries
            if entry["event"] == "claude.tool_call" and entry["status"] == "completed"
        )
        assert result["output"].endswith(TRUNCATED)
        assert outcome.success

    @pytest.mark.parametrize("status", ["completed", "failed", "stopped", "killed"])
    async def test_typed_background_task_lifecycle_is_metadata_only(self, tmp_path, status):
        usage = {"total_tokens": 22, "tool_uses": 3, "duration_ms": 1500}
        start = TaskStartedMessage(
            subtype="task_started",
            data={"raw": "must not log"},
            task_id="task-1",
            description="private task description",
            uuid="u-start",
            session_id="sess",
            tool_use_id="agent-1",
            task_type="local_agent",
        )
        progress = TaskProgressMessage(
            subtype="task_progress",
            data={},
            task_id="task-1",
            description="private progress",
            usage=usage,
            uuid="u-progress",
            session_id="sess",
            tool_use_id="agent-1",
            last_tool_name="Bash",
        )
        if status == "killed":
            terminal = TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id="task-1",
                status="killed",
                patch={"status": "killed", "summary": "private terminal summary"},
            )
        else:
            terminal = TaskNotificationMessage(
                subtype="task_notification",
                data={},
                task_id="task-1",
                status=status,
                output_file="private/output.txt",
                summary="private terminal summary",
                uuid="u-end",
                session_id="sess",
                tool_use_id="agent-1",
                usage=usage,
            )
        h = Harness(tmp_path, turns=[[start, progress, terminal, _result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        logs = [
            call.kwargs
            for call in h.harness.log.method_calls
            if call.args[0].startswith("claude.task_")
        ]
        assert len(logs) == 3
        assert all(entry["task_id"] == "task-1" and entry["message_id"] == "m1" for entry in logs)
        assert logs[0]["tool_use_id"] == logs[1]["tool_use_id"] == "agent-1"
        assert logs[1]["total_tokens"] == 22 and logs[1]["tool_uses"] == 3
        assert logs[1]["duration_seconds"] == 1.5
        assert logs[-1]["status"] == status
        assert "private" not in str(logs) and "must not log" not in str(logs)
        assert outcome.success
        assert [event["type"] for event in events] == ["step_finish"]
        if status == "failed":
            assert any(
                call.args[0] == "claude.task_notification"
                for call in h.harness.log.warn.call_args_list
            )

    @pytest.mark.parametrize(
        "turn,detail",
        [
            ([], "stream ended"),
            (
                [_result(0.1, subtype="error_max_turns", is_error=True, errors=["too many turns"])],
                "too many turns",
            ),
        ],
    )
    async def test_failed_outcomes_have_reason_in_final_diagnostic(self, tmp_path, turn, detail):
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await _run(h.harness)
        assert not outcome.success
        final = next(
            call.kwargs
            for call in h.harness.log.warn.call_args_list
            if call.args[0] == "claude.turn_end"
        )
        assert final["outcome"] == "failed" and detail in final["error"]
        assert final["message_id"] == "m1"
        assert final["duration_seconds"] >= 0

    async def test_completed_messages_tools_and_subagent_ids_without_stream_delta_logs(
        self, tmp_path: Path
    ) -> None:
        turn = [
            _stream("message_start", message={"id": "assistant-1"}),
            _text_delta("Hi"),
            _text_delta(" there"),
            AssistantMessage(
                content=[
                    TextBlock("Hi there"),
                    ThinkingBlock("hidden thinking", "signature"),
                    ToolUseBlock(
                        id="tool-1", name="Bash", input={"command": "ls", "api_key": "unknown"}
                    ),
                ],
                model="m",
                message_id="assistant-1",
            ),
            UserMessage(content=[ToolResultBlock(tool_use_id="tool-1", content="x" * 4000)]),
            AssistantMessage(
                content=[
                    TextBlock("not logged child text"),
                    ToolUseBlock(id="child-1", name="Read", input={"file_path": "f"}),
                ],
                model="m",
                message_id="child-msg",
                parent_tool_use_id="parent-1",
            ),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="child-1", content="failed", is_error=True)],
                parent_tool_use_id="parent-1",
            ),
            SystemMessage(subtype="compact_boundary", data={}),
            _result(0.2, usage={"input_tokens": 3, "output_tokens": 4}),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        logs = [
            (call.args[0], call.kwargs)
            for call in h.harness.log.method_calls
            if call[0] in ("info", "warn")
        ]
        assert "hidden thinking" not in str(logs)
        tools = [fields for event, fields in logs if event == "claude.tool_call"]
        assert [(entry["call_id"], entry["status"]) for entry in tools] == [
            ("tool-1", "running"),
            ("tool-1", "completed"),
            ("child-1", "running"),
            ("child-1", "error"),
        ]
        # The logging layer, not the observer, owns sanitization.
        assert tools[0]["args_preview"]["api_key"] == "unknown"
        assert tools[1]["output"] == "x" * 4000
        assert tools[2]["parent_tool_use_id"] == tools[3]["parent_tool_use_id"] == "parent-1"
        assistants = [fields for event, fields in logs if event == "claude.assistant_message"]
        assert len(assistants) == 1
        assert assistants[0]["text"] == "Hi there"
        assert assistants[0]["assistant_message_id"] == "assistant-1"
        assert all(fields["message_id"] == "m1" for fields in tools + assistants)
        assert any(event == "claude.context_compacted" for event, _ in logs)
        result = next(fields for event, fields in logs if event == "claude.result")
        finish = next(fields for event, fields in logs if event == "claude.step_finish")
        assert finish["message_cost_usd"] == 0.2
        assert finish["tokens"] == {"input": 3, "output": 4}
        assert result["outcome"] == "completed" and outcome.success
        # Logging operates on copies: the UI still receives complete original payloads.
        wire_tool = next(event for event in events if event["type"] == "tool_call")
        assert wire_tool["args"]["api_key"] == "unknown"
        assert (
            next(event for event in events if event.get("status") == "completed")["output"]
            == "x" * 4000
        )

    async def test_logging_handler_failure_does_not_change_delivery(self, tmp_path: Path) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[ToolUseBlock(id="t", name="Bash", input={})], model="m"
                    ),
                    _result(0.1),
                ]
            ],
        )
        await h.harness.open()
        await h.harness.create_session()

        def fail_diagnostics(event, **fields):
            if event in ("claude.tool_call", "claude.result", "claude.stderr"):
                raise RuntimeError("log handler failed")

        h.harness.log.info.side_effect = fail_diagnostics
        events, outcome = await _run(h.harness)
        h.client.options["stderr"]("diagnostic")
        assert outcome.success
        assert any(event["type"] == "tool_call" for event in events)

    async def test_tool_activity_is_logged_before_delivery_failure(self, tmp_path: Path) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[ToolUseBlock(id="t", name="Bash", input={})], model="m"
                    ),
                ]
            ],
        )
        await h.harness.open()
        await h.harness.create_session()

        async def failed_delivery(event):
            raise RuntimeError("websocket failed")

        outcome = await h.harness.run_prompt(
            HarnessPrompt(message_id="m1", text="hi"), failed_delivery
        )
        assert not outcome.success
        assert any(call.args[0] == "claude.tool_call" for call in h.harness.log.info.call_args_list)
