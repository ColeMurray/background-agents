"""Fold one prompt's OpenCode reasoning parts into a progress run per model step."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from .opencode_step_ids import StepIdTracker

# A step's reasoning event is re-sent whole on every change, so it keeps only
# the newest summaries, each trimmed to a display line's worth of text.
MAX_REASONING_SUMMARIES: Final = 50
MAX_REASONING_SUMMARY_CHARS: Final = 280
# Providers whose reasoning text is a provider-written summary meant for
# display. OpenCode's OpenAI adapter fills reasoning parts only from the
# Responses API's reasoning summaries, while OpenAI-compatible adapters copy
# raw `reasoning_content` into the same part under their own provider id.
# OpenCode does not mark summaries, so every other provider reports timing only.
# The gate checks the adapter as well as the provider: a provider id names
# configuration, and a repository's `opencode.json` can point `openai` at
# another SDK package that writes raw reasoning under the same id.
REASONING_SUMMARY_PROVIDERS: Final = frozenset({"openai"})
# Parts showing that a step has moved on from reasoning.
_OUTPUT_PART_TYPES: Final = frozenset({"text", "tool", "step-finish"})


def _epoch_ms(value: Any) -> int | None:
    """Read an OpenCode epoch-ms timestamp; non-finite values read as absent."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if math.isfinite(value) else None


def _trimmed_summary(text: Any) -> str:
    """A finished part's text as one forwarded summary, cut to the display limit."""
    if not isinstance(text, str):
        return ""
    summary = text.strip()
    if len(summary) > MAX_REASONING_SUMMARY_CHARS:
        summary = summary[: MAX_REASONING_SUMMARY_CHARS - 1].rstrip() + "…"
    return summary


def _filled_by_openai_adapter(part: dict[str, Any]) -> bool:
    """Whether OpenCode's OpenAI adapter wrote the part: it tags every reasoning
    part's metadata with its own `openai` entry."""
    metadata = part.get("metadata")
    return isinstance(metadata, dict) and isinstance(metadata.get("openai"), dict)


@dataclass
class _ReasoningRun:
    """Reasoning progress of one model step, reported whole on every change."""

    started_at_ms: int
    updated_at_ms: int
    summaries: list[dict[str, Any]] = field(default_factory=list)
    summary_count: int = 0
    # Cleared when the step moves on to output or finishes; set again if the
    # step resumes reasoning.
    active: bool = True

    def to_event(self, message_id: str, step_id: str) -> dict[str, Any]:
        return {
            "type": "reasoning",
            "messageId": message_id,
            "stepId": step_id,
            "startedAt": self.started_at_ms,
            "updatedAt": self.updated_at_ms,
            "summaries": list(self.summaries),
            "summaryCount": self.summary_count,
            "active": self.active,
        }


class ReasoningTracker:
    """Reasoning runs for one prompt's parent parts, one run per model step.

    A part belongs to the step it was first seen in and keeps that step, so a
    replayed part, or one recovered from the final message state, updates its
    own step's run whichever step is open now. Each part counts once: a new
    reasoning part's opening starts or resumes its step's run, its finish adds
    its summary, and the step's first output part ends the run.
    """

    def __init__(self, message_id: str, step_ids: StepIdTracker) -> None:
        self._message_id = message_id
        self._step_ids = step_ids
        self._runs: dict[str, _ReasoningRun] = {}
        self._part_steps: dict[str, str] = {}
        self._finished_part_ids: set[str] = set()
        self._summary_message_ids: set[str] = set()

    def record_provider(self, oc_message_id: str, provider_id: object) -> None:
        """Note an assistant message's provider; only summary providers' text is kept."""
        if provider_id in REASONING_SUMMARY_PROVIDERS:
            self._summary_message_ids.add(oc_message_id)

    def apply(self, part: dict[str, Any], step_id: str | None = None) -> list[dict[str, Any]]:
        """Fold one parent part into its step's run; the run's event if it changed.

        ``step_id`` places a part not seen before; by default it joins its
        message's open step.
        """
        part_type = part.get("type")
        part_id = part.get("id")
        if part_type != "reasoning" and part_type not in _OUTPUT_PART_TYPES:
            return []
        if not isinstance(part_id, str) or not part_id:
            return []
        is_new = part_id not in self._part_steps
        if is_new:
            oc_message_id = part.get("messageID") or ""
            self._part_steps[part_id] = (
                step_id or self._step_ids.current(oc_message_id) or oc_message_id
            )
        step_id = self._part_steps[part_id]
        if not step_id:
            return []
        if part_type == "reasoning":
            run = self._fold_reasoning(part, part_id, step_id, is_new=is_new)
        else:
            run = self._end(step_id)
        return [] if run is None else [run.to_event(self._message_id, step_id)]

    def reconcile(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        """Fold a fetched message's parts, each into the step it sits in.

        Returns the latest event of every run that changed, so parts the
        stream missed still reach the timeline.
        """
        info = message.get("info", {})
        step_id = info.get("id", "")
        self.record_provider(step_id, info.get("providerID"))
        latest: dict[str, dict[str, Any]] = {}
        for part in message.get("parts", []):
            if part.get("type") == "step-start" and part.get("id"):
                step_id = part["id"]
            for event in self.apply(part, step_id):
                latest[event["stepId"]] = event
        return list(latest.values())

    def _fold_reasoning(
        self, part: dict[str, Any], part_id: str, step_id: str, *, is_new: bool
    ) -> _ReasoningRun | None:
        """Start or resume a step's run from a new opening, or add a finish to it."""
        time_info = part.get("time")
        if not isinstance(time_info, dict):
            return None
        started = _epoch_ms(time_info.get("start"))
        ended = _epoch_ms(time_info.get("end"))
        run = self._runs.get(step_id)
        if ended is None:
            if not is_new or started is None or (run is not None and run.active):
                return None
            if run is None:
                run = self._runs[step_id] = _ReasoningRun(started, started)
            run.active = True
            run.updated_at_ms = max(run.updated_at_ms, started)
            return run

        if part_id in self._finished_part_ids:
            return None
        self._finished_part_ids.add(part_id)
        started = ended if started is None else started
        if run is None:
            run = self._runs[step_id] = _ReasoningRun(started, ended)
        # A part recovered after a later one was seen can predate the run.
        run.started_at_ms = min(run.started_at_ms, started)
        run.updated_at_ms = max(run.updated_at_ms, ended)
        from_summary_provider = part.get("messageID") in self._summary_message_ids
        is_summary = from_summary_provider and _filled_by_openai_adapter(part)
        summary = _trimmed_summary(part.get("text")) if is_summary else ""
        if summary:
            run.summary_count += 1
            run.summaries.append({"text": summary, "at": ended})
            del run.summaries[:-MAX_REASONING_SUMMARIES]
        return run

    def _end(self, step_id: str) -> _ReasoningRun | None:
        run = self._runs.get(step_id)
        if run is None or not run.active:
            return None
        run.active = False
        return run
