"""Correlation state for OpenCode child-session activity."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Final

MAX_PENDING_CHILD_ACTIVITY: Final = 2000


@dataclass(frozen=True)
class PendingChildMessage:
    child_session_id: str
    message_id: str
    can_correlate: bool


@dataclass(frozen=True)
class PendingChildError:
    child_session_id: str
    error: str
    can_correlate: bool


PendingChildActivity = PendingChildMessage | PendingChildError


class MessageDisposition(Enum):
    AUTHORIZED = "authorized"
    QUEUED = "queued"
    DROPPED = "dropped"


@dataclass
class ChildActivityCorrelator:
    """Own Task/child ownership and bounded pending activity for one prompt."""

    tracked_session_ids: set[str] = field(default_factory=set)
    _session_task_call_ids: dict[str, str] = field(default_factory=dict)
    _task_call_session_ids: dict[str, str] = field(default_factory=dict)
    _message_task_call_ids: dict[str, str] = field(default_factory=dict)
    _closed_session_task_call_ids: dict[str, str] = field(default_factory=dict)
    _pending: list[PendingChildActivity] = field(default_factory=list)
    _drop_logged: bool = False

    def track(self, child_session_id: str) -> bool:
        is_new = child_session_id not in self.tracked_session_ids
        self.tracked_session_ids.add(child_session_id)
        return is_new

    def is_tracked(self, child_session_id: object) -> bool:
        return isinstance(child_session_id, str) and child_session_id in self.tracked_session_ids

    def associate(self, child_session_id: str, task_call_id: str) -> bool:
        is_new = self.track(child_session_id)
        self._session_task_call_ids[child_session_id] = task_call_id
        self._task_call_session_ids[task_call_id] = child_session_id
        self._closed_session_task_call_ids.pop(child_session_id, None)
        return is_new

    def active_task(self, child_session_id: str) -> str | None:
        return self._session_task_call_ids.get(child_session_id)

    def task_for_activity(self, child_session_id: str) -> str | None:
        return self.active_task(child_session_id) or self._closed_session_task_call_ids.get(
            child_session_id
        )

    def child_for_task(self, task_call_id: str) -> str | None:
        return self._task_call_session_ids.get(task_call_id)

    def task_for_message(self, message_id: str) -> str | None:
        return self._message_task_call_ids.get(message_id)

    def authorize_or_queue_message(
        self, child_session_id: str, message_id: str
    ) -> MessageDisposition:
        if message_id in self._message_task_call_ids:
            return MessageDisposition.AUTHORIZED
        task_call_id = self.task_for_activity(child_session_id)
        if task_call_id:
            self._message_task_call_ids[message_id] = task_call_id
            return MessageDisposition.AUTHORIZED
        if any(
            isinstance(activity, PendingChildMessage) and activity.message_id == message_id
            for activity in self._pending
        ):
            return MessageDisposition.QUEUED
        if len(self._pending) >= MAX_PENDING_CHILD_ACTIVITY:
            return MessageDisposition.DROPPED
        self._pending.append(
            PendingChildMessage(
                child_session_id,
                message_id,
                child_session_id not in self._closed_session_task_call_ids,
            )
        )
        return MessageDisposition.QUEUED

    def queue_error(self, child_session_id: str, error: str) -> bool:
        if len(self._pending) >= MAX_PENDING_CHILD_ACTIVITY:
            return False
        self._pending.append(
            PendingChildError(
                child_session_id,
                error,
                child_session_id not in self._closed_session_task_call_ids,
            )
        )
        return True

    def release(self, child_session_id: str) -> list[PendingChildActivity]:
        released: list[PendingChildActivity] = []
        remaining: list[PendingChildActivity] = []
        for activity in self._pending:
            if activity.child_session_id != child_session_id or not activity.can_correlate:
                remaining.append(activity)
                continue
            if isinstance(activity, PendingChildMessage):
                task_call_id = self.active_task(child_session_id)
                if task_call_id:
                    self._message_task_call_ids[activity.message_id] = task_call_id
            released.append(activity)
        self._pending = remaining
        return released

    def flush(self) -> list[PendingChildActivity]:
        pending = self._pending
        self._pending = []
        return pending

    def task_for_pending(self, activity: PendingChildActivity) -> str | None:
        return self.active_task(activity.child_session_id) if activity.can_correlate else None

    def close(self, task_call_id: str) -> None:
        child_session_id = self.child_for_task(task_call_id)
        if child_session_id and self.active_task(child_session_id) == task_call_id:
            del self._session_task_call_ids[child_session_id]
            self._closed_session_task_call_ids[child_session_id] = task_call_id

    def should_log_drop(self) -> bool:
        if self._drop_logged:
            return False
        self._drop_logged = True
        return True
