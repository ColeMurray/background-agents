"""ReasoningTracker: one cumulative reasoning run per OpenCode model step.

Part payloads mirror OpenCode 1.18.29: a reasoning part opens with only
`time.start` and is re-sent with `time.end` and its text once it finishes.
"""

import json

import pytest

from sandbox_runtime.harness.opencode_reasoning import (
    MAX_REASONING_SUMMARIES,
    MAX_REASONING_SUMMARY_CHARS,
    ReasoningTracker,
)
from sandbox_runtime.harness.opencode_step_ids import StepIdTracker

MESSAGE_ID = "msg_assistant"
T0 = 1_754_000_002_000


def reasoning(
    part_id: str,
    start: int,
    end: int | None = None,
    text: str = "",
    adapter: str | None = "openai",
) -> dict:
    """A reasoning part, tagged in its metadata by the SDK adapter that wrote it."""
    time = {"start": start} if end is None else {"start": start, "end": end}
    part = {"type": "reasoning", "id": part_id, "messageID": MESSAGE_ID, "time": time, "text": text}
    if adapter is not None:
        part["metadata"] = {adapter: {"itemId": f"rs_{part_id}"}}
    return part


def part(part_type: str, part_id: str) -> dict:
    return {"type": part_type, "id": part_id, "messageID": MESSAGE_ID}


def make_tracker(provider_id: str = "openai") -> tuple[ReasoningTracker, StepIdTracker]:
    step_ids = StepIdTracker()
    tracker = ReasoningTracker("cp-msg-1", step_ids)
    tracker.record_provider(MESSAGE_ID, provider_id)
    step_ids.start(MESSAGE_ID, "prt_step_1")
    return tracker, step_ids


def summary_texts(events: list[dict]) -> list[str]:
    return [summary["text"] for summary in events[-1]["summaries"]]


class TestAccumulation:
    def test_first_opening_starts_the_clock_and_each_finish_adds_its_summary(self):
        tracker, _ = make_tracker()

        opened = tracker.apply(reasoning("prt_r1", T0))
        first = tracker.apply(reasoning("prt_r1", T0, T0 + 26_000, "**Reading the failing test**"))
        second_opened = tracker.apply(reasoning("prt_r2", T0 + 26_005))
        second = tracker.apply(reasoning("prt_r2", T0 + 26_005, T0 + 47_000, "**Planning**"))

        assert opened == [
            {
                "type": "reasoning",
                "messageId": "cp-msg-1",
                "stepId": "prt_step_1",
                "startedAt": T0,
                "updatedAt": T0,
                "summaries": [],
                "summaryCount": 0,
                "active": True,
            }
        ]
        assert first[0]["summaries"] == [
            {"text": "**Reading the failing test**", "at": T0 + 26_000}
        ]
        assert second_opened == []
        assert second[0]["startedAt"] == T0
        assert second[0]["updatedAt"] == T0 + 47_000
        assert summary_texts(second) == ["**Reading the failing test**", "**Planning**"]
        assert second[0]["summaryCount"] == 2

    def test_replayed_finish_is_ignored_and_empty_summary_only_advances_the_clock(self):
        tracker, _ = make_tracker()
        finished = reasoning("prt_r1", T0, T0 + 20_000, "**Planning**")
        tracker.apply(finished)

        replayed = tracker.apply(finished)
        empty = tracker.apply(reasoning("prt_r2", T0 + 20_001, T0 + 41_000))

        assert replayed == []
        assert empty[0]["updatedAt"] == T0 + 41_000
        assert empty[0]["summaryCount"] == 1

    def test_summaries_are_trimmed_and_only_the_newest_are_kept(self):
        tracker, _ = make_tracker()
        long_text = "  " + "x" * (MAX_REASONING_SUMMARY_CHARS + 50) + "\n"
        total = MAX_REASONING_SUMMARIES + 3

        events: list[dict] = []
        for index in range(total):
            text = long_text if index == total - 1 else f"**Thought {index}**"
            start = T0 + index * 1_000
            events = tracker.apply(reasoning(f"prt_r{index}", start, start + 500, text))

        latest = events[0]
        assert latest["summaryCount"] == total
        assert len(latest["summaries"]) == MAX_REASONING_SUMMARIES
        assert latest["summaries"][0]["text"] == "**Thought 3**"
        assert latest["summaries"][-1]["text"] == "x" * (MAX_REASONING_SUMMARY_CHARS - 1) + "…"

    def test_output_ends_the_run_and_only_a_new_reasoning_part_resumes_it(self):
        tracker, _ = make_tracker()
        tracker.apply(reasoning("prt_r1", T0))

        ended = tracker.apply(part("text", "prt_text"))
        further_output = tracker.apply(part("tool", "prt_tool"))
        replayed_opening = tracker.apply(reasoning("prt_r1", T0))
        resumed = tracker.apply(reasoning("prt_r2", T0 + 95_000))

        assert ended[0]["active"] is False
        assert further_output == []
        assert replayed_opening == []
        assert resumed[0]["active"] is True
        assert resumed[0]["updatedAt"] == T0 + 95_000


class TestSummaryProvenance:
    """Payloads captured from OpenCode 1.18.29 against localhost providers."""

    def test_openai_reasoning_summaries_are_kept(self):
        tracker, _ = make_tracker("openai")
        summary_part = {
            **reasoning("prt_r1", T0, T0 + 301, "**Summary title**\n\nSUMMARY-BODY"),
            "metadata": {"openai": {"itemId": "rs_1", "reasoningEncryptedContent": "enc"}},
        }

        events = tracker.apply(summary_part)

        assert summary_texts(events) == ["**Summary title**\n\nSUMMARY-BODY"]

    def test_openai_compatible_reasoning_content_is_withheld(self):
        """OpenAI-compatible adapters copy raw `reasoning_content` into the part
        under their own provider id, so the run keeps its timing only."""
        tracker, _ = make_tracker("deepseek")

        opened = tracker.apply(reasoning("prt_r1", T0, adapter=None))
        finished = tracker.apply(reasoning("prt_r1", T0, T0 + 46, "RAW-COMPAT-COT", adapter=None))

        assert opened[0]["active"] is True
        assert finished[0]["updatedAt"] == T0 + 46
        assert finished[0]["summaries"] == []
        assert finished[0]["summaryCount"] == 0

    @pytest.mark.parametrize("adapter", ["xai", None])
    def test_openai_id_without_the_openai_adapter_tag_is_withheld(self, adapter: str | None):
        """A repository's `opencode.json` can point the `openai` provider at
        another SDK package, such as `@ai-sdk/xai`, which merges raw reasoning
        into the part under the same provider id."""
        tracker, _ = make_tracker("openai")

        events = tracker.apply(reasoning("prt_r1", T0, T0 + 46, "RAW-XAI-COT", adapter=adapter))

        assert events[0]["updatedAt"] == T0 + 46
        assert events[0]["summaries"] == []
        assert events[0]["summaryCount"] == 0
        assert "RAW-XAI-COT" not in json.dumps(events)


class TestPartOwnership:
    def test_a_replayed_part_keeps_its_step_after_the_step_finishes(self):
        tracker, step_ids = make_tracker()
        finished = reasoning("prt_r1", T0, T0 + 5_000, "**First**")
        tracker.apply(finished)
        tracker.apply(part("text", "prt_text_1"))
        tracker.apply(part("step-finish", "prt_finish_1"))
        step_ids.finish(MESSAGE_ID, "prt_finish_1")

        assert tracker.apply(finished) == []
        assert tracker.apply(reasoning("prt_r1", T0)) == []

    def test_a_replayed_part_cannot_change_the_next_step(self):
        tracker, step_ids = make_tracker()
        finished = reasoning("prt_r1", T0, T0 + 5_000, "**First**")
        tracker.apply(finished)
        tracker.apply(part("text", "prt_text_1"))
        tracker.apply(part("step-finish", "prt_finish_1"))
        step_ids.finish(MESSAGE_ID, "prt_finish_1")
        step_ids.start(MESSAGE_ID, "prt_step_2")
        tracker.apply(reasoning("prt_r2", T0 + 9_000))

        replays = [
            tracker.apply(finished),
            tracker.apply(part("text", "prt_text_1")),
            tracker.apply(part("step-finish", "prt_finish_1")),
        ]
        second = tracker.apply(reasoning("prt_r2", T0 + 9_000, T0 + 12_000, "**Second**"))

        assert replays == [[], [], []]
        assert second[0]["stepId"] == "prt_step_2"
        assert second[0]["startedAt"] == T0 + 9_000
        assert second[0]["active"] is True
        assert summary_texts(second) == ["**Second**"]


class TestReconcile:
    def fetched(self, *parts: dict) -> dict:
        return {"info": {"id": MESSAGE_ID, "providerID": "openai"}, "parts": list(parts)}

    def test_recovers_finishes_the_stream_missed_into_their_own_steps(self):
        tracker, step_ids = make_tracker()
        tracker.apply(reasoning("prt_r1", T0))
        tracker.apply(reasoning("prt_r1", T0, T0 + 5_000, "**Early**"))
        tracker.apply(reasoning("prt_r2", T0 + 5_001))
        # The stream drops here; no step is open by the time state is fetched.
        step_ids.finish(MESSAGE_ID, "prt_finish_1")

        events = tracker.reconcile(
            self.fetched(
                part("step-start", "prt_step_1"),
                reasoning("prt_r1", T0, T0 + 5_000, "**Early**"),
                reasoning("prt_r2", T0 + 5_001, T0 + 120_000, "**Late**"),
                part("text", "prt_text_1"),
                part("step-finish", "prt_finish_1"),
                part("step-start", "prt_step_2"),
                reasoning("prt_r3", T0 + 130_000, T0 + 131_000, "**Next step**"),
            )
        )

        assert [(event["stepId"], event["active"]) for event in events] == [
            ("prt_step_1", False),
            ("prt_step_2", True),
        ]
        assert events[0]["startedAt"] == T0
        assert events[0]["updatedAt"] == T0 + 120_000
        assert summary_texts(events[:1]) == ["**Early**", "**Late**"]
        assert events[0]["summaryCount"] == 2
        assert summary_texts(events) == ["**Next step**"]

    def test_recovers_the_summary_of_a_run_the_stream_only_saw_open(self):
        tracker = ReasoningTracker("cp-msg-1", StepIdTracker())
        tracker.apply(reasoning("prt_r1", T0), "prt_step_1")

        events = tracker.reconcile(
            self.fetched(
                part("step-start", "prt_step_1"),
                reasoning("prt_r1", T0, T0 + 60_000, "**Planning**"),
            )
        )

        assert events[0]["summaryCount"] == 1
        assert events[0]["stepId"] == "prt_step_1"

    def test_a_fully_streamed_message_changes_nothing(self):
        tracker, step_ids = make_tracker()
        streamed = [
            reasoning("prt_r1", T0, T0 + 5_000, "**Plan**"),
            part("text", "prt_text_1"),
            part("step-finish", "prt_finish_1"),
        ]
        for streamed_part in streamed:
            tracker.apply(streamed_part)
        step_ids.finish(MESSAGE_ID, "prt_finish_1")

        assert tracker.reconcile(self.fetched(part("step-start", "prt_step_1"), *streamed)) == []
