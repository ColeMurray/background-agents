"""Parent-message attribution for one OpenCode prompt."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .opencode_identifier import OpenCodeIdentifier


class AssistantMessageDisposition(Enum):
    REJECT = "reject"
    ERROR_ONLY = "error_only"
    OUTPUT = "output"


@dataclass
class MessageAttribution:
    """Own message eligibility state for one prompt and its compaction chain."""

    prompt_user_message_id: str
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
        self, message_id: str, parent_id: str, *, is_summary: bool
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
            or self._compaction_fallback_accepts(message_id)
        ):
            self.allow_assistant(message_id)
            return AssistantMessageDisposition.OUTPUT
        return AssistantMessageDisposition.REJECT

    def _compaction_fallback_accepts(self, message_id: str) -> bool:
        """Claim only post-prompt messages after compaction rewrites the chain."""
        return self._compaction_occurred and OpenCodeIdentifier.is_after(
            message_id, self.prompt_user_message_id
        )
