"""Parent-message attribution for one OpenCode prompt."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class AssistantMessageDisposition(Enum):
    REJECT = "reject"
    ERROR_ONLY = "error_only"
    OUTPUT = "output"


@dataclass
class MessageAttribution:
    """Own message eligibility state for one prompt and its compaction chain."""

    prompt_user_message_id: str
    # OpenCode stamps every message with `time.created` on the same clock, so
    # this is the boundary the compaction fallback orders against.
    prompt_started_epoch_ms: int
    _user_message_ids: set[str] = field(default_factory=set, init=False)
    _allowed_assistant_message_ids: set[str] = field(default_factory=set, init=False)
    _correlated_summary_ids: set[str] = field(default_factory=set, init=False)
    _compaction_occurred: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self._user_message_ids.add(self.prompt_user_message_id)

    def add_user_message(self, message_id: str) -> bool:
        is_new = message_id not in self._user_message_ids
        self._user_message_ids.add(message_id)
        return is_new

    def parent_matches(self, parent_id: str) -> bool:
        return parent_id in self._user_message_ids

    def allow_assistant(self, message_id: str) -> None:
        self._allowed_assistant_message_ids.add(message_id)

    def is_assistant_allowed(self, message_id: str) -> bool:
        return message_id in self._allowed_assistant_message_ids

    @property
    def allowed_assistant_count(self) -> int:
        return len(self._allowed_assistant_message_ids)

    @property
    def is_compacted(self) -> bool:
        return self._compaction_occurred

    def mark_compacted(self) -> None:
        self._compaction_occurred = True

    def assistant_disposition(
        self,
        message_id: str,
        parent_id: str,
        *,
        is_summary: bool,
        created_epoch_ms: int | None,
    ) -> AssistantMessageDisposition:
        parent_matches = self.parent_matches(parent_id)
        if is_summary:
            if parent_matches:
                self._correlated_summary_ids.add(message_id)
        if message_id in self._correlated_summary_ids:
            return AssistantMessageDisposition.ERROR_ONLY
        if is_summary:
            return AssistantMessageDisposition.REJECT

        if (
            parent_matches
            or self.is_assistant_allowed(message_id)
            or self._compaction_fallback_accepts(created_epoch_ms)
        ):
            self.allow_assistant(message_id)
            return AssistantMessageDisposition.OUTPUT
        return AssistantMessageDisposition.REJECT

    def _compaction_fallback_accepts(self, created_epoch_ms: int | None) -> bool:
        """Claim only post-prompt messages after compaction rewrites the chain.

        Ordered by creation time rather than by message ID. OpenCode IDs encode
        a 48-bit truncation of their creation time, so they stop sorting
        monotonically every ~795 days; across such a rollover an earlier turn's
        messages compare greater than this prompt's and would be replayed as
        this turn's output. A message with no timestamp is rejected rather than
        risk that replay.

        The comparison is strict because the boundary is truncated to whole
        milliseconds: a prior turn's message created earlier within the
        boundary millisecond would otherwise be claimed. Nothing this prompt
        produces can share that millisecond — the boundary is taken before the
        prompt is posted, and this fallback only runs after a compaction and a
        model round trip.
        """
        if not self._compaction_occurred or created_epoch_ms is None:
            return False
        return created_epoch_ms > self.prompt_started_epoch_ms
