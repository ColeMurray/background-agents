"""
Unit tests for OpenCodePromptStream seams exposed by the extraction.

End-to-end SSE behavior is covered by test_bridge_sse.py; these tests target
the synchronous per-event translator (`_apply_sse_event`) dispositions and
the cross-prompt session-title dedupe, which are directly testable now.
"""

from unittest.mock import MagicMock

import pytest

from sandbox_runtime.constants import MAX_SNAPSHOT_RESERVE_SECONDS
from sandbox_runtime.harness.opencode_stream import (
    OpenCodePromptStream,
    _Disposition,
    _message_created_epoch_ms,
    _PromptState,
)
from sandbox_runtime.opencode_identifier import OpenCodeIdentifier
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
    def test_other_session_events_are_filtered_out(self):
        step = make_stream()._apply_sse_event(
            make_state(),
            sse("session.error", {"sessionID": "oc-unrelated", "error": {}}),
        )

        assert step.events == []
        assert step.disposition is _Disposition.CONTINUE

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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
