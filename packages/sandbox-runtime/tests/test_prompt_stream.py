"""
Unit tests for OpenCodePromptStream seams exposed by the extraction.

End-to-end SSE behavior is covered by test_bridge_sse.py; these tests target
the synchronous per-event translator (`_apply_sse_event`) dispositions and
the cross-prompt session-title dedupe, which are directly testable now.
"""

from unittest.mock import MagicMock

import pytest

from sandbox_runtime.constants import MAX_SNAPSHOT_RESERVE_SECONDS
from sandbox_runtime.opencode_identifier import OpenCodeIdentifier
from sandbox_runtime.prompt_stream import (
    OpenCodePromptStream,
    _Disposition,
    _message_created_epoch_ms,
    _PromptState,
)
from tests.conftest import oc_message_id

PARENT_SESSION_ID = "oc-session-123"
CHILD_SESSION_ID = "oc-child-456"

# Anchor for ID-boundary tests: the prompt's user message sits at a fixed
# (timestamp, counter) so neighbouring IDs can be placed exactly around it.
PROMPT_TS_MS = 1_754_000_000_000
PROMPT_MESSAGE_ID = oc_message_id(PROMPT_TS_MS, 2, "p")


def make_stream() -> OpenCodePromptStream:
    return OpenCodePromptStream(
        client=MagicMock(),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        sse_inactivity_timeout_seconds=120.0,
        prompt_max_duration_seconds=5400.0,
        prompt_cleanup_timeout_seconds=MAX_SNAPSHOT_RESERVE_SECONDS,
    )


def make_state(
    opencode_message_id: str = "msg_test", start_time: float = PROMPT_TS_MS / 1000
) -> _PromptState:
    """Anchor the prompt boundary to PROMPT_TS_MS so fixture creation times and
    fixture IDs describe the same instant."""
    state = _PromptState(
        opencode_session_id=PARENT_SESSION_ID,
        message_id="cp-msg-1",
        opencode_message_id=opencode_message_id,
        start_time=start_time,
    )
    return state


def sse(event_type: str, properties: dict) -> dict:
    return {"type": event_type, "properties": properties}


def test_message_created_epoch_ms_treats_unusable_values_as_absent():
    """Anything int() would reject must read as absent: raising here would tear
    down the SSE loop over one malformed message."""
    assert _message_created_epoch_ms({"time": {"created": PROMPT_TS_MS}}) == PROMPT_TS_MS
    assert _message_created_epoch_ms({}) is None
    assert _message_created_epoch_ms({"time": None}) is None
    assert _message_created_epoch_ms({"time": {}}) is None
    assert _message_created_epoch_ms({"time": {"created": "1754000000000"}}) is None
    assert _message_created_epoch_ms({"time": {"created": True}}) is None
    assert _message_created_epoch_ms({"time": {"created": float("nan")}}) is None
    assert _message_created_epoch_ms({"time": {"created": float("inf")}}) is None


def test_oc_message_id_matches_real_generator_format():
    """The fixture helper must reproduce OpenCodeIdentifier's encoding, so
    boundary tests exercise the real ID contract rather than ad-hoc strings."""
    real = OpenCodeIdentifier.ascending("message")
    encoded = int(real[4:16], 16)
    rebuilt = oc_message_id(encoded // 0x1000, encoded % 0x1000)

    assert rebuilt[:16] == real[:16]
    assert len(rebuilt) == len(real)


class TestApplySseEventDispositions:
    @pytest.mark.parametrize("event_type", ["server.connected", "server.heartbeat"])
    def test_server_events_are_noops(self, event_type: str):
        step = make_stream()._apply_sse_event(make_state(), sse(event_type, {}))

        assert step.events == []
        assert step.disposition is _Disposition.CONTINUE

    def test_parent_session_idle_finishes_stream(self):
        step = make_stream()._apply_sse_event(
            make_state(), sse("session.idle", {"sessionID": PARENT_SESSION_ID})
        )

        assert step.disposition is _Disposition.FINISHED_IDLE

    def test_child_session_idle_does_not_finish_stream(self):
        state = make_state()
        state.child_activity.track(CHILD_SESSION_ID)

        step = make_stream()._apply_sse_event(
            state, sse("session.idle", {"sessionID": CHILD_SESSION_ID})
        )

        assert step.disposition is _Disposition.CONTINUE

    def test_parent_status_idle_finishes_stream(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse(
                "session.status",
                {"sessionID": PARENT_SESSION_ID, "status": {"type": "idle"}},
            ),
        )

        assert step.disposition is _Disposition.FINISHED_IDLE

    def test_parent_session_error_fails_stream(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse(
                "session.error",
                {
                    "sessionID": PARENT_SESSION_ID,
                    "error": {"name": "SomeError", "data": {"message": "It broke"}},
                },
            ),
        )

        assert step.disposition is _Disposition.FAILED
        assert step.events == [{"type": "error", "error": "It broke", "messageId": "cp-msg-1"}]

    def test_parent_context_overflow_continues_without_error(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse(
                "session.error",
                {
                    "sessionID": PARENT_SESSION_ID,
                    "error": {
                        "name": "ContextOverflowError",
                        "data": {"message": "Context window exceeded"},
                    },
                },
            ),
        )

        assert step.disposition is _Disposition.CONTINUE
        assert step.events == []

    def test_message_error_is_deduped_against_session_error(self):
        stream = make_stream()
        state = make_state()
        error = {"name": "SomeError", "data": {"message": "It broke"}}

        message_step = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": "msg_test",
                        "error": error,
                    }
                },
            ),
        )
        session_step = stream._apply_sse_event(
            state,
            sse("session.error", {"sessionID": PARENT_SESSION_ID, "error": error}),
        )

        assert message_step.events == [
            {"type": "error", "error": "It broke", "messageId": "cp-msg-1"}
        ]
        assert session_step.disposition is _Disposition.FAILED
        assert session_step.events == []

    def test_unrelated_compaction_summary_error_is_ignored(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "oc-old-summary",
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": "msg-old-compaction-user",
                        "summary": True,
                        "error": {
                            "name": "ContextOverflowError",
                            "data": {"message": "Old compaction failed"},
                        },
                    }
                },
            ),
        )

        assert step.events == []
        assert step.disposition is _Disposition.CONTINUE

    def test_correlated_compaction_summary_error_is_emitted(self):
        stream = make_stream()
        state = make_state()
        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "msg-compaction-user",
                        "role": "user",
                        "sessionID": PARENT_SESSION_ID,
                    }
                },
            ),
        )
        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "oc-summary",
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": "msg-compaction-user",
                        "summary": True,
                    }
                },
            ),
        )

        step = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "oc-summary",
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "summary": True,
                        "error": {
                            "name": "ContextOverflowError",
                            "data": {"message": "Compaction failed"},
                        },
                    }
                },
            ),
        )

        assert step.events == [
            {"type": "error", "error": "Compaction failed", "messageId": "cp-msg-1"}
        ]

    def test_compaction_summary_parts_not_forwarded_despite_parent_match(self):
        stream = make_stream()
        state = make_state()
        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "msg-compaction-user",
                        "role": "user",
                        "sessionID": PARENT_SESSION_ID,
                    }
                },
            ),
        )
        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "oc-summary",
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": "msg-compaction-user",
                        "summary": True,
                    }
                },
            ),
        )

        step = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-summary",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "oc-summary",
                        "text": "## Goal\nInternal summary text",
                    }
                },
            ),
        )

        assert not state.attribution.is_assistant_allowed("oc-summary")
        assert step.events == []

    def test_child_context_overflow_continues_without_error(self):
        state = make_state()
        state.child_activity.track(CHILD_SESSION_ID)

        step = make_stream()._apply_sse_event(
            state,
            sse(
                "session.error",
                {
                    "sessionID": CHILD_SESSION_ID,
                    "error": {
                        "name": "ContextOverflowError",
                        "data": {"message": "Context window exceeded"},
                    },
                },
            ),
        )

        assert step.disposition is _Disposition.CONTINUE
        assert step.events == []

    def test_unrecovered_overflow_fails_at_idle(self):
        stream = make_stream()
        state = make_state()
        stream._apply_sse_event(
            state,
            sse(
                "session.error",
                {
                    "sessionID": PARENT_SESSION_ID,
                    "error": {
                        "name": "ContextOverflowError",
                        "data": {"message": "Context window exceeded"},
                    },
                },
            ),
        )

        step = stream._apply_sse_event(state, sse("session.idle", {"sessionID": PARENT_SESSION_ID}))

        assert step.disposition is _Disposition.FINISHED_IDLE
        assert step.events == [
            {"type": "error", "error": "Context window exceeded", "messageId": "cp-msg-1"}
        ]

    def test_recovered_overflow_stays_clean_at_idle(self):
        stream = make_stream()
        state = make_state()
        stream._apply_sse_event(
            state,
            sse(
                "session.error",
                {
                    "sessionID": PARENT_SESSION_ID,
                    "error": {
                        "name": "ContextOverflowError",
                        "data": {"message": "Context window exceeded"},
                    },
                },
            ),
        )
        stream._apply_sse_event(state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID}))

        step = stream._apply_sse_event(state, sse("session.idle", {"sessionID": PARENT_SESSION_ID}))

        assert step.disposition is _Disposition.FINISHED_IDLE
        assert step.events == []

    def test_child_session_error_emits_subtask_error_and_continues(self):
        state = make_state()
        state.child_activity.associate(CHILD_SESSION_ID, "task-call-1")

        step = make_stream()._apply_sse_event(
            state,
            sse("session.error", {"sessionID": CHILD_SESSION_ID, "error": {}}),
        )

        assert step.disposition is _Disposition.CONTINUE
        assert step.events == [
            {
                "type": "error",
                "error": "Sub-task error",
                "messageId": "cp-msg-1",
                "isSubtask": True,
                "childSessionId": CHILD_SESSION_ID,
                "taskCallId": "task-call-1",
            }
        ]

    def test_child_session_error_after_completion_keeps_completed_task_ownership(self):
        state = make_state()
        state.child_activity.associate(CHILD_SESSION_ID, "task-call-1")
        state.child_activity.close("task-call-1")

        step = make_stream()._apply_sse_event(
            state,
            sse("session.error", {"sessionID": CHILD_SESSION_ID, "error": {}}),
        )

        assert step.events[0]["taskCallId"] == "task-call-1"

    def test_uncorrelated_child_error_is_flushed_at_parent_idle(self):
        state = make_state()
        state.child_activity.track(CHILD_SESSION_ID)
        stream = make_stream()

        error_step = stream._apply_sse_event(
            state,
            sse("session.error", {"sessionID": CHILD_SESSION_ID, "error": {}}),
        )
        idle_step = stream._apply_sse_event(
            state,
            sse("session.idle", {"sessionID": PARENT_SESSION_ID}),
        )

        assert error_step.events == []
        assert idle_step.events == []
        assert stream._flush_unassociated_child_activity(state) == [
            {
                "type": "error",
                "error": "Sub-task error",
                "messageId": "cp-msg-1",
                "isSubtask": True,
                "childSessionId": CHILD_SESSION_ID,
            }
        ]

    def test_late_child_part_keeps_message_ownership_after_task_completion(self):
        state = make_state()
        state.attribution.allow_assistant("parent-msg")
        state.child_activity.associate(CHILD_SESSION_ID, "task-call")
        stream = make_stream()

        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg",
                        "role": "assistant",
                        "sessionID": CHILD_SESSION_ID,
                    }
                },
            ),
        )
        stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "parent-msg",
                        "tool": "task",
                        "callID": "task-call",
                        "state": {"status": "completed", "input": {"prompt": "review"}},
                    }
                },
            ),
        )
        late_part = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": CHILD_SESSION_ID,
                        "messageID": "child-msg",
                        "tool": "Read",
                        "callID": "late-call",
                        "state": {"status": "completed", "input": {"filePath": "README.md"}},
                    }
                },
            ),
        )

        assert late_part.events[0]["taskCallId"] == "task-call"

    def test_child_message_after_completion_keeps_completed_task_ownership(self):
        state = make_state()
        state.attribution.allow_assistant("parent-msg")
        stream = make_stream()

        completed_task = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "parent-msg",
                        "tool": "task",
                        "callID": "closed-task",
                        "state": {
                            "status": "completed",
                            "input": {"prompt": "review"},
                            "metadata": {"sessionId": CHILD_SESSION_ID},
                        },
                    }
                },
            ),
        )
        late_message = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "late-child-msg",
                        "role": "assistant",
                        "sessionID": CHILD_SESSION_ID,
                    }
                },
            ),
        )
        late_part = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": CHILD_SESSION_ID,
                        "messageID": "late-child-msg",
                        "tool": "Read",
                        "callID": "late-call",
                        "state": {"status": "completed", "input": {"filePath": "README.md"}},
                    }
                },
            ),
        )
        resumed_task = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "parent-msg",
                        "tool": "task",
                        "callID": "task-call-2",
                        "state": {
                            "status": "running",
                            "input": {"prompt": "resume"},
                            "metadata": {"sessionId": CHILD_SESSION_ID},
                        },
                    }
                },
            ),
        )
        repeated_message = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "late-child-msg",
                        "role": "assistant",
                        "sessionID": CHILD_SESSION_ID,
                    }
                },
            ),
        )
        final_part = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": CHILD_SESSION_ID,
                        "messageID": "late-child-msg",
                        "tool": "Bash",
                        "callID": "final-call",
                        "state": {"status": "completed", "input": {"command": "git status"}},
                    }
                },
            ),
        )
        orphaned = stream._flush_unassociated_child_activity(state)

        assert completed_task.events[0]["childSessionId"] == CHILD_SESSION_ID
        assert late_message.events == []
        assert late_part.events == [
            {
                "type": "tool_call",
                "tool": "Read",
                "args": {"filePath": "README.md"},
                "callId": "late-call",
                "status": "completed",
                "output": "",
                "messageId": "cp-msg-1",
                "isSubtask": True,
                "childSessionId": CHILD_SESSION_ID,
                "taskCallId": "closed-task",
            }
        ]
        assert resumed_task.events == [
            {
                "type": "tool_call",
                "tool": "task",
                "args": {"prompt": "resume"},
                "callId": "task-call-2",
                "status": "running",
                "output": "",
                "messageId": "cp-msg-1",
                "childSessionId": CHILD_SESSION_ID,
            }
        ]
        assert repeated_message.events == []
        assert final_part.events[0]["taskCallId"] == "closed-task"
        assert orphaned == []

    def test_other_session_events_are_filtered_out(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse("session.error", {"sessionID": "oc-unrelated", "error": {}}),
        )

        assert step.events == []
        assert step.disposition is _Disposition.CONTINUE

    def test_parent_compaction_sets_state_flag(self):
        state = make_state()

        step = make_stream()._apply_sse_event(
            state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID})
        )

        assert state.attribution.is_compacted
        assert step.events == [{"type": "context_compacted", "messageId": "cp-msg-1"}]
        assert step.disposition is _Disposition.CONTINUE

    def test_each_parent_compaction_emits_a_marker(self):
        state = make_state()
        stream = make_stream()

        first = stream._apply_sse_event(
            state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID})
        )
        second = stream._apply_sse_event(
            state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID})
        )

        expected = [{"type": "context_compacted", "messageId": "cp-msg-1"}]
        assert first.events == expected
        assert second.events == expected

    def test_child_compaction_does_not_emit_parent_marker(self):
        state = make_state()
        state.child_activity.track(CHILD_SESSION_ID)
        state.pending_overflow_error = "parent overflow"

        step = make_stream()._apply_sse_event(
            state, sse("session.compacted", {"sessionID": CHILD_SESSION_ID})
        )

        assert not state.attribution.is_compacted
        assert state.pending_overflow_error == "parent overflow"
        assert step.events == []

    def test_post_compaction_prior_prompt_message_is_not_accepted(self):
        """The compaction fallback must not claim messages created before the
        prompt: forwarding them would replay prior turns' text as current
        output."""
        prior_assistant_id = oc_message_id(PROMPT_TS_MS - 60_000, 1, "q")
        prior_user_id = oc_message_id(PROMPT_TS_MS - 61_000, 1, "u")
        stream = make_stream()
        state = make_state(PROMPT_MESSAGE_ID)
        stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-prior",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": prior_assistant_id,
                        "text": "Stale text from an earlier turn",
                    }
                },
            ),
        )
        stream._apply_sse_event(state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID}))

        step = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": prior_assistant_id,
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": prior_user_id,
                        "time": {"created": PROMPT_TS_MS - 60_000},
                    }
                },
            ),
        )

        assert not state.attribution.is_assistant_allowed(prior_assistant_id)
        assert prior_assistant_id in state.pending_parts
        assert step.events == []

    def test_post_compaction_later_message_is_accepted(self):
        continuation_id = oc_message_id(PROMPT_TS_MS + 5_000, 1, "r")
        continue_user_id = oc_message_id(PROMPT_TS_MS + 4_000, 1, "v")
        stream = make_stream()
        state = make_state(PROMPT_MESSAGE_ID)
        stream._apply_sse_event(state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID}))

        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": continuation_id,
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": continue_user_id,
                        "time": {"created": PROMPT_TS_MS + 5_000},
                    }
                },
            ),
        )
        step = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-continuation",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": continuation_id,
                        "text": "Continuing after compaction",
                    }
                },
            ),
        )

        assert state.attribution.is_assistant_allowed(continuation_id)
        assert step.events == [
            {
                "type": "token",
                "content": "Continuing after compaction",
                "messageId": "cp-msg-1",
            }
        ]

    def test_post_compaction_millisecond_boundary(self):
        """The boundary is the prompt's start millisecond and the comparison is
        strict: a message created in that same millisecond is rejected, because
        a prior turn could have produced it earlier within that millisecond."""
        at_boundary_id = oc_message_id(PROMPT_TS_MS, 1, "s")
        after_boundary_id = oc_message_id(PROMPT_TS_MS + 1, 3, "t")
        stream = make_stream()
        state = make_state(PROMPT_MESSAGE_ID)
        stream._apply_sse_event(state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID}))

        for oc_msg_id, created in (
            (at_boundary_id, PROMPT_TS_MS),
            (after_boundary_id, PROMPT_TS_MS + 1),
        ):
            stream._apply_sse_event(
                state,
                sse(
                    "message.updated",
                    {
                        "info": {
                            "id": oc_msg_id,
                            "role": "assistant",
                            "sessionID": PARENT_SESSION_ID,
                            "parentID": oc_message_id(PROMPT_TS_MS, 0, "w"),
                            "time": {"created": created},
                        }
                    },
                ),
            )

        assert not state.attribution.is_assistant_allowed(at_boundary_id)
        assert state.attribution.is_assistant_allowed(after_boundary_id)

    def test_post_compaction_error_on_prior_prompt_message_is_ignored(self):
        prior_assistant_id = oc_message_id(PROMPT_TS_MS - 60_000, 1, "q")
        stream = make_stream()
        state = make_state(PROMPT_MESSAGE_ID)
        stream._apply_sse_event(state, sse("session.compacted", {"sessionID": PARENT_SESSION_ID}))

        step = stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": prior_assistant_id,
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": oc_message_id(PROMPT_TS_MS - 61_000, 1, "u"),
                        "time": {"created": PROMPT_TS_MS - 60_000},
                        "error": {"name": "SomeError", "data": {"message": "Old failure"}},
                    }
                },
            ),
        )

        assert step.events == []

    def test_session_created_tracks_direct_children_only(self):
        state = make_state()
        stream = make_stream()

        stream._apply_sse_event(
            state,
            sse(
                "session.created",
                {"info": {"id": CHILD_SESSION_ID, "parentID": PARENT_SESSION_ID}},
            ),
        )
        stream._apply_sse_event(
            state,
            sse(
                "session.created",
                {"info": {"id": "oc-grandchild", "parentID": CHILD_SESSION_ID}},
            ),
        )

        assert state.child_activity.tracked_session_ids == {CHILD_SESSION_ID}

    def test_task_metadata_reemits_same_status_and_releases_buffered_child_activity(self):
        state = make_state()
        state.attribution.allow_assistant("parent-msg")
        state.child_activity.track(CHILD_SESSION_ID)
        stream = make_stream()

        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg",
                        "role": "assistant",
                        "sessionID": CHILD_SESSION_ID,
                    }
                },
            ),
        )
        stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": CHILD_SESSION_ID,
                        "messageID": "child-msg",
                        "tool": "Bash",
                        "callID": "child-call",
                        "state": {"status": "running", "input": {"command": "ls"}},
                    }
                },
            ),
        )
        first_task = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "parent-msg",
                        "tool": "task",
                        "callID": "task-call",
                        "state": {"status": "running", "input": {"prompt": "review"}},
                    }
                },
            ),
        )
        correlated_task = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "sessionID": PARENT_SESSION_ID,
                        "messageID": "parent-msg",
                        "tool": "task",
                        "callID": "task-call",
                        "state": {
                            "status": "running",
                            "input": {"prompt": "review"},
                            "metadata": {"sessionId": CHILD_SESSION_ID},
                        },
                    }
                },
            ),
        )

        assert first_task.events[0].get("childSessionId") is None
        assert correlated_task.events == [
            {
                **first_task.events[0],
                "childSessionId": CHILD_SESSION_ID,
            },
            {
                "type": "tool_call",
                "tool": "Bash",
                "args": {"command": "ls"},
                "callId": "child-call",
                "status": "running",
                "output": "",
                "messageId": "cp-msg-1",
                "isSubtask": True,
                "childSessionId": CHILD_SESSION_ID,
                "taskCallId": "task-call",
            },
        ]


class TestSessionTitleDedupe:
    def title_event(self, stream: OpenCodePromptStream, state: _PromptState, title: str):
        return stream._apply_sse_event(
            state,
            sse(
                "session.updated",
                {"info": {"id": PARENT_SESSION_ID, "title": title}},
            ),
        )

    def test_title_dedupe_survives_across_prompts(self):
        """The same title must be forwarded at most once per bridge lifetime,
        even when a later prompt re-delivers it (dedupe state lives on the
        long-lived stream, not in per-call state)."""
        stream = make_stream()

        first = self.title_event(stream, make_state(), "Fix the login bug")
        second = self.title_event(stream, make_state(), "Fix the login bug")
        changed = self.title_event(stream, make_state(), "Fix login and signup")

        assert first.events == [{"type": "session_title", "title": "Fix the login bug"}]
        assert second.events == []
        assert changed.events == [{"type": "session_title", "title": "Fix login and signup"}]

    def test_default_opencode_title_is_not_forwarded(self):
        stream = make_stream()

        step = self.title_event(stream, make_state(), "New Session - 2026-07-18T00:00:00.000Z")

        assert step.events == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
