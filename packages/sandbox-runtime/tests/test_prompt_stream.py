"""
Unit tests for OpenCodePromptStream seams exposed by the extraction.

End-to-end SSE behavior is covered by test_bridge_sse.py; these tests target
the synchronous per-event translator (`_apply_sse_event`) dispositions and
the cross-prompt session-title dedupe, which are directly testable now.
"""

import json
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.constants import MAX_SNAPSHOT_RESERVE_SECONDS
from sandbox_runtime.harness.opencode_client import SSEConnectionError, SSEStreamDisconnectedError
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


def make_stream(client: Any = None) -> OpenCodePromptStream:
    return OpenCodePromptStream(
        client=client or MagicMock(),
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


class TestReasoningProgress:
    """Parent reasoning parts become one cumulative `reasoning` event per step.

    The part sequence mirrors what OpenCode 1.18.29 emits: a reasoning part
    opens with only `time.start`, its summary arrives as one
    `message.part.delta`, and the part is re-sent with `time.end` and the text.
    """

    ASSISTANT_ID = oc_message_id(PROMPT_TS_MS + 1_000, 1, "a")
    T0 = PROMPT_TS_MS + 2_000

    def authorized(self, provider_id: str = "openai") -> tuple[OpenCodePromptStream, _PromptState]:
        stream = make_stream()
        state = make_state(PROMPT_MESSAGE_ID)
        stream._apply_sse_event(
            state,
            sse(
                "message.updated",
                {
                    "info": {
                        "id": self.ASSISTANT_ID,
                        "role": "assistant",
                        "sessionID": PARENT_SESSION_ID,
                        "parentID": PROMPT_MESSAGE_ID,
                        "providerID": provider_id,
                        "time": {"created": PROMPT_TS_MS + 1_000},
                    }
                },
            ),
        )
        self.apply(stream, state, {"type": "step-start", "id": "prt_step_1"})
        return stream, state

    def apply_all(
        self, stream: OpenCodePromptStream, state: _PromptState, part: dict
    ) -> list[dict]:
        step = stream._apply_sse_event(
            state,
            sse(
                "message.part.updated",
                {"part": {"sessionID": PARENT_SESSION_ID, "messageID": self.ASSISTANT_ID, **part}},
            ),
        )
        return step.events

    def apply(self, stream: OpenCodePromptStream, state: _PromptState, part: dict) -> list[dict]:
        return [
            event for event in self.apply_all(stream, state, part) if event["type"] == "reasoning"
        ]

    def reasoning(self, part_id: str, start: int, end: int | None = None, text: str = "") -> dict:
        """A reasoning part as OpenCode's OpenAI adapter writes it."""
        time = {"start": start} if end is None else {"start": start, "end": end}
        return {
            "type": "reasoning",
            "id": part_id,
            "time": time,
            "text": text,
            "metadata": {"openai": {"itemId": f"rs_{part_id}"}},
        }

    def test_each_step_gets_its_own_run(self):
        stream, state = self.authorized()
        self.apply(stream, state, self.reasoning("prt_r1", self.T0, self.T0 + 5_000, "**First**"))
        self.apply(stream, state, {"type": "step-finish", "id": "prt_finish_1"})
        self.apply(stream, state, {"type": "step-start", "id": "prt_step_2"})

        later = self.apply(
            stream, state, self.reasoning("prt_r2", self.T0 + 9_000, self.T0 + 12_000, "**Second**")
        )

        assert later[0]["stepId"] == "prt_step_2"
        assert later[0]["startedAt"] == self.T0 + 9_000
        assert [summary["text"] for summary in later[0]["summaries"]] == ["**Second**"]

    def test_a_replayed_part_keeps_the_step_it_was_streamed_in(self):
        stream, state = self.authorized()
        finished = self.reasoning("prt_r1", self.T0, self.T0 + 5_000, "**First**")
        self.apply(stream, state, finished)
        self.apply(stream, state, {"type": "step-finish", "id": "prt_finish_1"})

        after_finish = self.apply(stream, state, finished)
        self.apply(stream, state, {"type": "step-start", "id": "prt_step_2"})
        opened = self.apply(stream, state, self.reasoning("prt_r2", self.T0 + 9_000))
        during_next_step = self.apply(stream, state, finished)
        later = self.apply(
            stream, state, self.reasoning("prt_r2", self.T0 + 9_000, self.T0 + 12_000, "**Second**")
        )

        assert after_finish == []
        assert during_next_step == []
        assert opened[0]["stepId"] == "prt_step_2"
        assert later[0]["startedAt"] == self.T0 + 9_000
        assert [summary["text"] for summary in later[0]["summaries"]] == ["**Second**"]

    def test_output_ends_reasoning_and_resumed_reasoning_reopens_it(self):
        """Clients see a text part only once it completes, so reasoning has to be
        reported as over when the text starts, not when its token arrives."""
        stream, state = self.authorized()
        self.apply(stream, state, self.reasoning("prt_r1", self.T0, self.T0 + 20_000, "**Plan**"))

        text_started = self.apply_all(
            stream, state, {"type": "text", "id": "prt_text", "text": "", "time": {"start": 1}}
        )
        text_finished = self.apply_all(
            stream,
            state,
            {"type": "text", "id": "prt_text", "text": "Here is the plan.", "time": {"start": 1}},
        )
        resumed = self.apply(stream, state, self.reasoning("prt_r2", self.T0 + 95_000))
        finished = self.apply(stream, state, {"type": "step-finish", "id": "prt_finish_1"})

        assert text_started == [
            {
                "type": "reasoning",
                "messageId": "cp-msg-1",
                "stepId": "prt_step_1",
                "startedAt": self.T0,
                "updatedAt": self.T0 + 20_000,
                "summaries": [{"text": "**Plan**", "at": self.T0 + 20_000}],
                "summaryCount": 1,
                "active": False,
            }
        ]
        assert [event["type"] for event in text_finished] == ["token"]
        assert resumed[0]["active"] is True
        assert resumed[0]["updatedAt"] == self.T0 + 95_000
        assert finished[0]["active"] is False

    def test_reasoning_text_is_withheld_for_providers_without_summaries(self):
        stream, state = self.authorized(provider_id="anthropic")

        opened = self.apply(stream, state, self.reasoning("prt_r1", self.T0))
        finished = self.apply(
            stream,
            state,
            self.reasoning("prt_r1", self.T0, self.T0 + 30_000, "Raw reasoning about the bug"),
        )

        assert opened[0]["active"] is True
        assert finished[0]["updatedAt"] == self.T0 + 30_000
        assert finished[0]["summaries"] == []
        assert finished[0]["summaryCount"] == 0
        assert "Raw reasoning" not in json.dumps(finished)

    def test_child_reasoning_is_not_forwarded(self):
        stream, state = self.authorized()

        events = stream._handle_part(
            state,
            {
                "sessionID": CHILD_SESSION_ID,
                "messageID": "msg_child",
                **self.reasoning("prt_child", self.T0, self.T0 + 1_000, "**Child thought**"),
            },
            None,
            is_subtask=True,
        )

        assert events == []

    async def test_a_dropped_stream_recovers_reasoning_from_the_final_message_state(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The stream drops mid-step; a finish only the fetched message holds
        still reaches its step, though no step is open any more."""
        monkeypatch.setattr(
            OpenCodeIdentifier, "ascending", classmethod(lambda cls, prefix: PROMPT_MESSAGE_ID)
        )
        info = {
            "id": self.ASSISTANT_ID,
            "role": "assistant",
            "sessionID": PARENT_SESSION_ID,
            "parentID": PROMPT_MESSAGE_ID,
            "providerID": "openai",
        }
        parts = [
            {"type": "step-start", "id": "prt_step_1"},
            self.reasoning("prt_r1", self.T0, self.T0 + 5_000, "**Early**"),
            self.reasoning("prt_r2", self.T0 + 5_001, self.T0 + 120_000, "**Late**"),
        ]
        parts = [
            {"sessionID": PARENT_SESSION_ID, "messageID": self.ASSISTANT_ID, **p} for p in parts
        ]
        client = _DroppingClient(
            [
                sse("message.updated", {"info": info}),
                *(sse("message.part.updated", {"part": p}) for p in parts[:2]),
                sse(
                    "message.part.updated",
                    {"part": {**parts[2], "time": {"start": self.T0 + 5_001}}},
                ),
            ],
            final_messages=[{"info": info, "parts": parts}],
        )

        events = []
        with pytest.raises(SSEConnectionError):
            async for event in make_stream(client).stream_prompt(
                opencode_session_id=PARENT_SESSION_ID, message_id="cp-msg-1", content="Fix it"
            ):
                events.append(event)

        recovered = [event for event in events if event["type"] == "reasoning"][-1]
        assert recovered["stepId"] == "prt_step_1"
        assert recovered["updatedAt"] == self.T0 + 120_000
        assert [summary["text"] for summary in recovered["summaries"]] == ["**Early**", "**Late**"]


class _DroppingClient:
    """An OpenCode client whose event stream drops after the given events."""

    def __init__(self, sse_events: list[dict], *, final_messages: list[dict]) -> None:
        self._sse_events = sse_events
        self._final_messages = final_messages

    @asynccontextmanager
    async def events(self, *, inactivity_timeout_seconds: float):
        async def dropping():
            for event in self._sse_events:
                yield event
            raise SSEStreamDisconnectedError("peer closed connection")

        yield dropping()

    async def post_prompt(self, opencode_session_id: str, request_body: dict) -> None:
        pass

    async def get_messages(self, opencode_session_id: str) -> list[dict]:
        return self._final_messages


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
