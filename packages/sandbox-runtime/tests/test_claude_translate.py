"""Typed Claude SDK translation and conversation-lived task correlation."""

from __future__ import annotations

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ConversationResetMessage,
    ResultMessage,
    SystemMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from sandbox_runtime.harness.claude_translate import (
    MAX_TRACKED_TASKS,
    OI_TOOL_PREFIX,
    ClaudeTranslation,
    ClaudeTranslator,
    ClaudeTurnState,
    SdkTurnResult,
    TrajectoryRecord,
)
from tests.claude_fakes import _result


def _task_started(task_id="task", parent_id="parent"):
    return TaskStartedMessage(
        subtype="task_started",
        data={},
        task_id=task_id,
        description="inspect",
        uuid="u",
        session_id="native",
        tool_use_id=parent_id,
    )


def _task_progress(task_id="task", parent_id=None):
    return TaskProgressMessage(
        subtype="task_progress",
        data={},
        task_id=task_id,
        description="uncollected-progress-description",
        usage={"total_tokens": 25, "tool_uses": 2, "duration_ms": 100},
        uuid="p",
        session_id="native",
        tool_use_id=parent_id,
        last_tool_name="Read",
    )


def _task_terminal(kind, status="completed", task_id="task"):
    if kind == "notification":
        return TaskNotificationMessage(
            subtype="task_notification",
            data={},
            task_id=task_id,
            status=status,
            output_file="file",
            summary="uncollected-summary",
            uuid="n",
            session_id="native",
        )
    return TaskUpdatedMessage(
        subtype="task_updated",
        data={},
        task_id=task_id,
        patch={"status": status},
        status=status,
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
def test_terminal_tasks_are_recorded_with_the_parent_then_evicted(kind, status):
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    started = translator.translate(state, _task_started(), interrupted=False)
    assert started.records[0].fields["parent_tool_use_id"] == "parent"
    assert translator._task_parents == {"task": "parent"}

    terminal = translator.translate(state, _task_terminal(kind, status), interrupted=False)
    assert isinstance(terminal, ClaudeTranslation)
    assert len(terminal.records) == 1 and isinstance(terminal.records[0], TrajectoryRecord)
    assert terminal.records[0].event == f"claude.task.{kind}"
    assert terminal.records[0].fields == {
        "task_id": "task",
        "parent_tool_use_id": "parent",
        "status": status,
        **({"error_preview": None} if kind == "updated" else {}),
    }
    assert terminal.events == [] and terminal.result is None and terminal.outcome is None
    assert not translator._task_parents


@pytest.mark.parametrize("reset", ["explicit", "conversation", "native_change"])
def test_session_resets_clear_stale_parent_mappings(reset):
    translator = ClaudeTranslator()
    translator.session_id = "native"
    translator.cost_baseline = 0.5
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.5)
    translator.translate(state, _task_started(), interrupted=False)
    assert translator._task_parents == {"task": "parent"}

    if reset == "explicit":
        translator.reset_tracking()
    elif reset == "conversation":
        translator.translate(
            state,
            ConversationResetMessage(
                new_conversation_id="new-conversation", uuid="r", session_id="native"
            ),
            interrupted=False,
        )
    else:
        changed = translator.translate(
            state,
            SystemMessage(subtype="init", data={"session_id": "new-native"}),
            interrupted=False,
        )
        assert changed.agent_session_id == "new-native"

    assert not translator._task_parents
    assert translator.cost_baseline == (0.0 if reset == "conversation" else 0.5)
    assert state.cost_baseline == (0.0 if reset == "conversation" else 0.5)
    late = translator.translate(state, _task_terminal("updated"), interrupted=False)
    assert late.records[0].fields["parent_tool_use_id"] is None


@pytest.mark.parametrize("baseline", [0.5, None], ids=["known-cost", "unknown-cost"])
def test_conversation_reset_during_injected_turn_updates_cost_and_resumable_session(baseline):
    translator = ClaudeTranslator()
    translator.session_id = "native"
    translator.cost_baseline = baseline
    state = ClaudeTurnState(message_id="prompt", cost_baseline=baseline)
    translator.translate(state, _task_started(), interrupted=False)
    translator.translate(
        state,
        UserMessage(content="injected content", origin={"kind": "task-notification"}),
        interrupted=False,
    )
    assert state.injected and translator._task_parents

    reset = translator.translate(
        state,
        ConversationResetMessage(
            new_conversation_id="new-conversation", uuid="r", session_id="native"
        ),
        interrupted=False,
    )
    assert reset.events == [] and reset.outcome is None
    assert state.injected and not translator._task_parents
    assert translator.cost_baseline == state.cost_baseline == 0.0
    assert translator._session_rotated and translator._observed_native_id == "native"

    injected = translator.translate(
        state,
        _result(0.05, session_id="new-native", origin={"kind": "task-notification"}),
        interrupted=False,
    )
    assert injected.events == [] and injected.outcome is None and injected.result is None
    assert not state.injected and translator.session_id == "native"
    assert translator.cost_baseline == state.cost_baseline == 0.0

    human = translator.translate(
        state,
        _result(0.2, session_id="new-native", origin={"kind": "human"}),
        interrupted=False,
    )
    assert human.outcome is not None and human.outcome.success
    assert human.outcome.message_cost_usd == pytest.approx(0.2)
    assert human.events[0]["messageCostUsd"] == pytest.approx(0.2)
    assert len(human.events) == 1
    assert translator.session_id == human.agent_session_id == "new-native"
    assert not translator._session_rotated and translator.cost_baseline == pytest.approx(0.2)
    assert next(
        record for record in human.records if record.event == "claude.session.rotated"
    ).fields == {
        "agent_session_id": "new-native",
        "previous_session_id": "native",
    }


def test_task_parent_survives_a_new_turn_state_until_terminal_update():
    translator = ClaudeTranslator()
    first = ClaudeTurnState(message_id="first", cost_baseline=0.0)
    translator.translate(first, _task_started(), interrupted=False)
    second = ClaudeTurnState(message_id="second", cost_baseline=0.1)
    progress = translator.translate(second, _task_progress(), interrupted=False)
    assert progress.records == [
        TrajectoryRecord(
            "claude.task.progress",
            {
                "task_id": "task",
                "parent_tool_use_id": "parent",
                "total_tokens": 25,
                "tool_uses": 2,
                "duration_ms": 100,
                "last_tool_name": "Read",
            },
        )
    ]
    assert translator._task_parents == {"task": "parent"}
    terminal = translator.translate(second, _task_terminal("updated"), interrupted=False)
    assert terminal.records[0].fields["parent_tool_use_id"] == "parent"
    assert not translator._task_parents


@pytest.mark.parametrize("kind", ["started", "progress"])
def test_orphan_task_tracking_is_bounded_and_evicts_oldest_parents(kind):
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    total = MAX_TRACKED_TASKS * 2 + 3
    for index in range(total):
        task_id, parent_id = f"task-{index}", f"parent-{index}"
        message = (
            _task_started(task_id, parent_id)
            if kind == "started"
            else _task_progress(task_id, parent_id)
        )
        translation = translator.translate(state, message, interrupted=False)
        assert translation.records[0].fields["parent_tool_use_id"] == parent_id
        assert len(translator._task_parents) <= MAX_TRACKED_TASKS

    assert translator._task_parents == {
        f"task-{index}": f"parent-{index}" for index in range(total - MAX_TRACKED_TASKS, total)
    }
    evicted = translator.translate(
        state, _task_terminal("updated", task_id="task-0"), interrupted=False
    )
    assert evicted.records[0].fields["parent_tool_use_id"] is None
    assert len(translator._task_parents) == MAX_TRACKED_TASKS
    retained = translator.translate(
        state, _task_terminal("updated", task_id=f"task-{total - 1}"), interrupted=False
    )
    assert retained.records[0].fields["parent_tool_use_id"] == f"parent-{total - 1}"
    assert len(translator._task_parents) == MAX_TRACKED_TASKS - 1


@pytest.mark.parametrize("kind", ["notification", "updated"])
def test_reused_terminal_task_id_never_inherits_the_previous_parent(kind):
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="first", cost_baseline=0.0)
    translator.translate(state, _task_started(), interrupted=False)
    translator.translate(state, _task_terminal(kind), interrupted=False)
    assert not translator._task_parents

    state = ClaudeTurnState(message_id="second", cost_baseline=0.1)
    uncorrelated = translator.translate(state, _task_started(parent_id=None), interrupted=False)
    assert uncorrelated.records[0].fields["parent_tool_use_id"] is None
    assert not translator._task_parents
    progress = translator.translate(state, _task_progress(), interrupted=False)
    assert progress.records[0].fields["parent_tool_use_id"] is None

    restarted = translator.translate(
        state, _task_started(parent_id="new-parent"), interrupted=False
    )
    assert restarted.records[0].fields["parent_tool_use_id"] == "new-parent"
    terminal = translator.translate(state, _task_terminal(kind), interrupted=False)
    assert terminal.records[0].fields["parent_tool_use_id"] == "new-parent"
    assert not translator._task_parents
    duplicate = translator.translate(state, _task_terminal(kind), interrupted=False)
    assert duplicate.records[0].fields["parent_tool_use_id"] is None


def test_reused_running_task_id_updates_parent_without_growing_tracking():
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    translator.translate(state, _task_started(), interrupted=False)
    restarted = translator.translate(
        state, _task_started(parent_id="new-parent"), interrupted=False
    )
    assert translator._task_parents == {"task": "new-parent"}
    assert restarted.records[0].fields["parent_tool_use_id"] == "new-parent"
    terminal = translator.translate(state, _task_terminal("updated"), interrupted=False)
    assert terminal.records[0].fields["parent_tool_use_id"] == "new-parent"
    assert not translator._task_parents


@pytest.mark.parametrize("is_error", [False, True], ids=["success", "error"])
@pytest.mark.parametrize("parent_id", [None, "parent"], ids=["root", "subtask"])
@pytest.mark.parametrize(
    "sdk_tool,wire_tool",
    [
        ("Bash", "Bash"),
        ("Agent", "task"),
        (f"{OI_TOOL_PREFIX}read_file", "read_file"),
        ("mcp__external__lookup", "mcp__external__lookup"),
    ],
)
def test_tool_wire_events_and_typed_log_records_share_correlation(
    is_error, parent_id, sdk_tool, wire_tool
):
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.0)
    args = {"command": "ls", "nested": {"api_key": "wire-private-value"}}
    assistant = AssistantMessage(
        content=[ToolUseBlock(id="call", name=sdk_tool, input=args)],
        model="m",
        session_id="native",
        parent_tool_use_id=parent_id,
    )
    started = translator.translate(state, assistant, interrupted=False)
    expected_start = {
        "type": "tool_call",
        "tool": wire_tool,
        "args": args,
        "callId": "call",
        "status": "running",
        "output": "",
        "messageId": "prompt",
    }
    if parent_id:
        expected_start.update(isSubtask=True, taskCallId=parent_id)
    assert isinstance(started, ClaudeTranslation)
    assert [event for event in started.events if event["type"] == "tool_call"] == [expected_start]
    assert started.records == [
        TrajectoryRecord(
            "claude.tool.started",
            {
                "tool": wire_tool,
                "call_id": "call",
                "status": "running",
                "parent_tool_use_id": parent_id,
                "args_preview": args,
            },
        )
    ]

    output = "wire-private-output"
    result = UserMessage(
        content=[ToolResultBlock(tool_use_id="call", content=output, is_error=is_error)],
        parent_tool_use_id=parent_id,
    )
    completed = translator.translate(state, result, interrupted=False)
    status = "error" if is_error else "completed"
    assert isinstance(completed, ClaudeTranslation)
    assert completed.events == [{**expected_start, "status": status, "output": output}]
    assert completed.records == [
        TrajectoryRecord(
            "claude.tool.failed" if is_error else "claude.tool.completed",
            {
                "tool": wire_tool,
                "call_id": "call",
                "status": status,
                "parent_tool_use_id": parent_id,
                "output_preview": output,
            },
        )
    ]
    assert all(
        isinstance(record, TrajectoryRecord) for record in started.records + completed.records
    )
    assert started.agent_session_id == completed.agent_session_id == "native"
    assert started.result is None and completed.result is None
    assert started.outcome is None and completed.outcome is None
    assert args == {"command": "ls", "nested": {"api_key": "wire-private-value"}}
    assert assistant.content[0].input == args and result.content[0].content == output


@pytest.mark.parametrize(
    "subtype,is_error,interrupted",
    [
        ("success", False, False),
        ("error_during_execution", True, False),
        ("success", False, True),
    ],
    ids=["success", "error", "interrupted"],
)
def test_result_translation_exposes_typed_metadata_and_turn_outcome(subtype, is_error, interrupted):
    translator = ClaudeTranslator()
    state = ClaudeTurnState(message_id="prompt", cost_baseline=0.1)
    usage = {
        "input_tokens": 100,
        "output_tokens": 200,
        "cache_read_input_tokens": 10,
        "cache_creation_input_tokens": 20,
        "uncollected": "private-usage-metadata",
    }
    result = ResultMessage(
        subtype=subtype,
        duration_ms=100,
        duration_api_ms=50,
        is_error=is_error,
        num_turns=2,
        session_id="native",
        total_cost_usd=0.3,
        usage=usage,
        result="SDK error detail" if is_error else None,
    )
    translation = translator.translate(state, result, interrupted=interrupted)
    tokens = {"input": 100, "output": 200, "cache": {"read": 10, "write": 20}}
    assert isinstance(translation, ClaudeTranslation)
    assert isinstance(translation.result, SdkTurnResult)
    assert translation.result == SdkTurnResult(
        status=subtype,
        is_error=is_error,
        duration_ms=100,
        duration_api_ms=50,
        num_turns=2,
        total_cost_usd=0.3,
        tokens=tokens,
    )
    finish = translation.events[0]
    assert finish["type"] == "step_finish" and finish["messageId"] == "prompt"
    assert finish["reason"] == subtype and finish["tokens"] == tokens
    assert finish["messageCostUsd"] == pytest.approx(0.2)
    assert translation.agent_session_id == "native"
    assert translation.outcome is not None
    assert translation.outcome.success == (not is_error and not interrupted)
    assert translation.outcome.cancelled == interrupted
    assert translation.outcome.message_cost_usd == pytest.approx(0.2)
    if is_error:
        assert translation.outcome.error == "SDK error detail"
    elif interrupted:
        assert translation.outcome.error == "Task was cancelled"
    else:
        assert translation.outcome.error is None
    assert result.usage == usage and translator.cost_baseline == 0.3
