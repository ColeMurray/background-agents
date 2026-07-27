"""
Unit tests for OpenCodePromptStream seams exposed by the extraction.

End-to-end SSE behavior is covered by test_bridge_sse.py; these tests target
the synchronous per-event translator (`_apply_sse_event`) dispositions and
the cross-prompt session-title dedupe, which are directly testable now.
"""

import time
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.prompt_stream import (
    OpenCodePromptStream,
    _Disposition,
    _PromptState,
)

PARENT_SESSION_ID = "oc-session-123"
CHILD_SESSION_ID = "oc-child-456"


def make_stream() -> OpenCodePromptStream:
    return OpenCodePromptStream(
        client=MagicMock(),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        sse_inactivity_timeout_seconds=120.0,
        prompt_max_duration_seconds=5400.0,
    )


def make_state() -> _PromptState:
    state = _PromptState(
        opencode_session_id=PARENT_SESSION_ID,
        message_id="cp-msg-1",
        opencode_message_id="msg_test",
        start_time=time.time(),
    )
    state.user_message_ids.add("msg_test")
    return state


def sse(event_type: str, properties: dict) -> dict:
    return {"type": event_type, "properties": properties}


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
        state.tracked_child_session_ids.add(CHILD_SESSION_ID)

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

        assert "oc-summary" not in state.allowed_assistant_msg_ids
        assert step.events == []

    def test_child_context_overflow_continues_without_error(self):
        state = make_state()
        state.tracked_child_session_ids.add(CHILD_SESSION_ID)

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
        state.tracked_child_session_ids.add(CHILD_SESSION_ID)

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
            }
        ]

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

        assert state.compaction_occurred is True
        assert step.disposition is _Disposition.CONTINUE

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

        assert state.tracked_child_session_ids == {CHILD_SESSION_ID}


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
