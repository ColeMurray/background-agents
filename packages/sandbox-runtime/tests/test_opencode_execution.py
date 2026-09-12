"""Lifecycle evidence is independent of UI visibility and SSE delivery order."""

import pytest

from sandbox_runtime.harness.opencode_execution import OpenCodeExecutionLedger

ROOT = "root"
USER = "current-user"
STARTED_MS = 1000


def event(event_type, **properties):
    return {"type": event_type, "properties": properties}


def message(session_id=ROOT, message_id="assistant", parent_id=USER, **extra):
    return event(
        "message.updated",
        info={
            "id": message_id,
            "sessionID": session_id,
            "role": "assistant",
            "parentID": parent_id,
            **extra,
        },
    )


def tool(session_id, status, *, call_id="call", **extra):
    return event(
        "message.part.updated",
        part={
            "sessionID": session_id,
            "messageID": "assistant",
            "id": f"part-{call_id}",
            "callID": call_id,
            "type": "tool",
            "tool": "bash",
            "state": {"status": status},
            **extra,
        },
    )


def created(session_id, parent_id):
    return event("session.created", info={"id": session_id, "parentID": parent_id})


def idle(session_id):
    return event("session.idle", sessionID=session_id)


def ledger(*events):
    result = OpenCodeExecutionLedger(ROOT, USER, STARTED_MS)
    for item in events:
        result.observe(item)
    return result


@pytest.mark.parametrize("session_id", ["child", "grandchild"])
@pytest.mark.parametrize(
    "activity",
    [
        "message",
        "early_text_part",
        "pending_tool",
        "running_tool",
        "missing_tool_status",
        "delta",
        "missing_session_status",
    ],
)
def test_activity_revokes_direct_or_nested_idle_without_busy_status(session_id, activity):
    execution = ledger(
        message(),
        created("child", ROOT),
        created("grandchild", "child"),
        idle("child"),
        idle("grandchild"),
        idle(ROOT),
    )
    assert execution.execution_stopped
    activities = {
        "message": message(session_id, "late-message"),
        "early_text_part": event(
            "message.part.updated",
            part={"sessionID": session_id, "messageID": "not-announced", "type": "text"},
        ),
        "pending_tool": tool(session_id, "pending"),
        "running_tool": tool(session_id, "running"),
        "missing_tool_status": tool(session_id, None),
        "delta": event("message.part.delta", sessionID=session_id, delta="later"),
        "missing_session_status": event("session.status", sessionID=session_id),
    }

    execution.observe(activities[activity])
    execution.observe(idle(ROOT))

    assert not execution.execution_stopped
    if "tool" in activity:
        execution.observe(idle(session_id))
        assert not execution.execution_stopped  # Idle cannot erase an unresolved tool.
        execution.observe(tool(session_id, "completed"))
        assert not execution.execution_stopped  # Completion itself is new activity.
    execution.observe(idle(session_id))
    assert execution.execution_stopped


@pytest.mark.parametrize(
    "before_ownership",
    [
        [created("grandchild", "child"), idle("grandchild"), tool("grandchild", "running")],
        [idle("grandchild"), tool("grandchild", "running"), created("grandchild", "child")],
        [tool("grandchild", "running"), idle("grandchild"), created("grandchild", "child")],
    ],
)
def test_reordered_ancestry_cannot_discard_preexisting_grandchild_work(before_ownership):
    execution = ledger(
        message(), *before_ownership, created("child", ROOT), idle("child"), idle(ROOT)
    )

    assert not execution.execution_stopped
    execution.observe(tool("grandchild", "completed"))
    execution.observe(idle("grandchild"))
    assert execution.execution_stopped


def test_delayed_creation_preserves_explicit_idle_seen_after_completed_work():
    execution = ledger(
        message(),
        tool("grandchild", "completed"),
        idle("grandchild"),
        created("grandchild", "child"),
        created("child", ROOT),
        idle("child"),
        idle(ROOT),
    )

    assert execution.execution_stopped


def test_task_metadata_discovers_reused_nested_children_without_creation_events():
    execution = ledger(
        # The root task part precedes the message that proves it is our turn.
        tool(
            ROOT,
            "running",
            tool="task",
            state={"status": "running", "metadata": {"sessionId": "child"}},
        ),
        tool(
            "child",
            "completed",
            tool="task",
            state={"status": "completed", "metadata": {"sessionId": "grandchild"}},
        ),
        tool("grandchild", "running"),
        message(),
        # Terminal updates can omit metadata; ownership must not disappear.
        tool(ROOT, "completed", tool="task"),
        idle("child"),
        idle(ROOT),
    )

    assert not execution.execution_stopped
    execution.observe(tool("grandchild", "completed"))
    execution.observe(idle("grandchild"))
    assert execution.execution_stopped


def test_unrelated_session_activity_does_not_prevent_confirmed_turn_completion():
    execution = ledger(
        message(), created("unrelated", "different-root"), tool("unrelated", "running"), idle(ROOT)
    )

    assert execution.execution_stopped


def test_unattributed_root_task_metadata_cannot_hide_running_child():
    execution = ledger(
        message(),
        tool(
            ROOT,
            "completed",
            tool="task",
            messageID="not-yet-announced",
            state={
                "status": "completed",
                "metadata": {"sessionId": "child"},
            },
        ),
        tool("child", "running"),
        idle(ROOT),
    )

    assert not execution.execution_stopped


def test_tool_call_ids_are_scoped_to_messages_not_just_sessions():
    execution = ledger(
        message(),
        tool(ROOT, "running", messageID="first-message"),
        tool(ROOT, "completed", messageID="second-message"),
        idle(ROOT),
    )

    assert not execution.execution_stopped


def test_reassigning_message_ancestry_cannot_grant_current_turn_evidence():
    execution = ledger(message(parent_id="different-turn"), message(parent_id=USER), idle(ROOT))

    assert not execution.execution_stopped


@pytest.mark.parametrize("created_ms", [None, STARTED_MS - 1, STARTED_MS])
def test_replayed_user_message_cannot_authorize_a_different_root_turn(created_ms):
    extra = {} if created_ms is None else {"time": {"created": created_ms}}
    execution = ledger(
        message(message_id="old-user", role="user", **extra),
        message(message_id="old-assistant", parent_id="old-user"),
        idle(ROOT),
    )

    assert not execution.execution_stopped


def test_fresh_rewritten_user_chain_is_correlated_by_time_not_message_id_order():
    execution = ledger(
        message(message_id="rewritten-user", role="user", time={"created": STARTED_MS + 1}),
        message(parent_id="rewritten-user"),
        idle(ROOT),
    )

    assert execution.execution_stopped


@pytest.mark.parametrize("created_ms", [None, STARTED_MS, STARTED_MS + 1])
def test_compaction_fallback_requires_fresh_root_activity(created_ms):
    extra = {} if created_ms is None else {"time": {"created": created_ms}}
    execution = ledger(
        event("session.compacted", sessionID=ROOT),
        message(parent_id="synthetic-parent", **extra),
        idle(ROOT),
    )

    assert execution.execution_stopped is (created_ms == STARTED_MS + 1)


def test_fresh_unrelated_assistant_is_not_current_turn_without_compaction():
    execution = ledger(
        message(parent_id="other-user", time={"created": STARTED_MS + 1}), idle(ROOT)
    )

    assert not execution.execution_stopped


def test_descendant_messages_do_not_supply_positive_root_turn_evidence():
    execution = ledger(created("child", ROOT), message("child"), idle("child"), idle(ROOT))

    assert not execution.execution_stopped


def test_completed_tool_followed_by_late_running_event_is_active_again():
    execution = ledger(message(), tool(ROOT, "completed"), idle(ROOT))
    assert execution.execution_stopped

    execution.observe(tool(ROOT, "running"))
    execution.observe(idle(ROOT))

    assert not execution.execution_stopped


def test_missing_session_id_uses_previously_observed_message_ownership():
    execution = ledger(
        message(),
        created("child", ROOT),
        message("child", "child-message"),
        idle("child"),
        idle(ROOT),
    )
    assert execution.execution_stopped

    execution.observe(
        event("message.part.updated", part={"messageID": "child-message", "type": "text"})
    )

    assert not execution.execution_stopped


def test_conflicting_session_identity_never_supplies_positive_evidence():
    conflicting = message()
    conflicting["properties"]["sessionID"] = "different-session"
    execution = ledger(conflicting, message(), idle(ROOT))

    assert not execution.execution_stopped


def test_bounded_evidence_overflow_latches_uncertainty():
    execution = OpenCodeExecutionLedger(ROOT, USER, STARTED_MS, max_records=3)
    for item in [
        message(),
        created("child", ROOT),
        created("grandchild", "child"),
        idle("child"),
        idle(ROOT),
    ]:
        execution.observe(item)

    assert not execution.execution_stopped
