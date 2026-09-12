"""Pure, fail-closed execution evidence for one OpenCode turn.

This consumes raw protocol events, not authorized timeline events. Presentation
may omit or buffer descendant activity; neither may hide work from containment.
Only explicit idle events establish idleness, and later activity revokes it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Final

MAX_EXECUTION_EVIDENCE_RECORDS: Final = 2000


def _object(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _identifier(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def message_created_epoch_ms(info: dict[str, Any]) -> int | None:
    """Read a finite message creation timestamp without trusting ID ordering."""
    created = _object(info.get("time")).get("created")
    if isinstance(created, bool) or not isinstance(created, (int, float)):
        return None
    return int(created) if math.isfinite(created) else None


@dataclass
class _SessionEvidence:
    parent_id: str | None = None
    idle: bool = False


@dataclass(frozen=True)
class _MessageEvidence:
    session_id: str
    role: str | None
    parent_id: str | None
    created_epoch_ms: int | None


@dataclass(frozen=True)
class _ToolEvidence:
    session_id: str
    active: bool
    child_session_id: str | None


class OpenCodeExecutionLedger:
    """Track cessation independently of timeline attribution and event order.

    Compact records retain activity before a session's ancestry is known. The
    ownership closure is resolved when evidence is read, so reordered ancestor
    creation and task metadata do not discard a running nested tool. Records
    never contain text or tool arguments. Overflow latches uncertainty instead
    of silently dropping evidence and eventually declaring the runtime reusable.
    """

    def __init__(
        self,
        root_session_id: str,
        prompt_user_message_id: str,
        prompt_started_epoch_ms: int,
        *,
        max_records: int = MAX_EXECUTION_EVIDENCE_RECORDS,
    ) -> None:
        self._root_session_id = root_session_id
        self._prompt_user_message_id = prompt_user_message_id
        self._prompt_started_epoch_ms = prompt_started_epoch_ms
        self._max_records = max_records
        self._sessions: dict[str, _SessionEvidence] = {}
        self._messages: dict[str, _MessageEvidence] = {}
        self._tools: dict[tuple[str, str | None, str], _ToolEvidence] = {}
        self._compacted = False
        self._incomplete = False

    def observe(self, event: dict[str, Any]) -> None:
        """Apply one raw SSE event before any filtering or UI correlation."""
        event_type = event.get("type")
        if not isinstance(event_type, str) or not event_type.startswith(("session.", "message.")):
            return
        props = _object(event.get("properties"))
        info = _object(props.get("info"))
        part = _object(props.get("part"))
        session_id = self._event_session_id(event_type, props, info, part)
        if session_id is None:
            self._incomplete = True
            return
        session = self._session(session_id)
        if session is None:
            return

        if event_type in ("session.created", "session.updated"):
            parent_id = _identifier(info.get("parentID"))
            if parent_id is not None:
                if session.parent_id not in (None, parent_id):
                    self._incomplete = True
                session.parent_id = parent_id
            # A delayed creation/title notification is not execution activity.
            return
        if event_type == "session.idle":
            session.idle = True
            return
        if event_type == "session.status":
            session.idle = _object(props.get("status")).get("type") == "idle"
            return

        # Includes early parts, nested messages, and delta events without a
        # preceding session.status=busy or a UI-authorized message.updated.
        session.idle = False
        if event_type == "session.compacted" and session_id == self._root_session_id:
            self._compacted = True
        elif event_type == "message.updated":
            self._observe_message(session_id, info)
        elif event_type == "message.part.updated" and part.get("type") == "tool":
            self._observe_tool(session_id, part)

    @property
    def execution_stopped(self) -> bool:
        """True only for a correlated turn with idle owned sessions and no tools."""
        current_message_ids = self._current_root_message_ids()
        if self._incomplete or not current_message_ids:
            return False
        owned = {self._root_session_id}
        while True:
            descendants = {
                session_id
                for session_id, session in self._sessions.items()
                if session.parent_id in owned
            }
            descendants.update(
                tool.child_session_id
                for tool in self._tools.values()
                if tool.child_session_id is not None and tool.session_id in owned
            )
            if descendants <= owned:
                break
            owned.update(descendants)
        return all(
            session_id in self._sessions and self._sessions[session_id].idle for session_id in owned
        ) and not any(tool.active and tool.session_id in owned for tool in self._tools.values())

    def _current_root_message_ids(self) -> set[str]:
        """Do not let replayed/missing-time user IDs authorize a different turn."""
        user_ids = {self._prompt_user_message_id}
        user_ids.update(
            message_id
            for message_id, message in self._messages.items()
            if message.session_id == self._root_session_id
            and message.role == "user"
            and self._created_during_turn(message)
        )
        return {
            message_id
            for message_id, message in self._messages.items()
            if message.session_id == self._root_session_id
            and message.role == "assistant"
            and (
                message.parent_id in user_ids
                or (self._compacted and self._created_during_turn(message))
            )
        }

    def _created_during_turn(self, message: _MessageEvidence) -> bool:
        return (
            message.created_epoch_ms is not None
            and message.created_epoch_ms > self._prompt_started_epoch_ms
        )

    def _event_session_id(
        self,
        event_type: str,
        props: dict[str, Any],
        info: dict[str, Any],
        part: dict[str, Any],
    ) -> str | None:
        ids = {
            session_id
            for value in (props.get("sessionID"), info.get("sessionID"), part.get("sessionID"))
            if (session_id := _identifier(value)) is not None
        }
        if event_type in ("session.created", "session.updated"):
            if session_id := _identifier(info.get("id")):
                ids.add(session_id)
        if len(ids) > 1:
            return None
        if ids:
            return ids.pop()
        message_id = _identifier(info.get("id") or part.get("messageID") or props.get("messageID"))
        message = self._messages.get(message_id) if message_id else None
        return message.session_id if message else None

    def _session(self, session_id: str) -> _SessionEvidence | None:
        if session_id not in self._sessions:
            if not self._reserve_record():
                return None
            self._sessions[session_id] = _SessionEvidence()
        return self._sessions[session_id]

    def _observe_message(self, session_id: str, info: dict[str, Any]) -> None:
        message_id = _identifier(info.get("id"))
        if message_id is None:
            self._incomplete = True
            return
        previous = self._messages.get(message_id)
        if previous is None and not self._reserve_record():
            return
        message = _MessageEvidence(
            session_id=session_id,
            role=_identifier(info.get("role")) or (previous.role if previous else None),
            parent_id=_identifier(info.get("parentID"))
            or (previous.parent_id if previous else None),
            created_epoch_ms=message_created_epoch_ms(info)
            if "time" in info or previous is None
            else previous.created_epoch_ms,
        )
        if previous is not None and (
            previous.session_id != session_id
            or (previous.role is not None and previous.role != message.role)
            or (previous.parent_id is not None and previous.parent_id != message.parent_id)
        ):
            self._incomplete = True
        self._messages[message_id] = message

    def _observe_tool(self, session_id: str, part: dict[str, Any]) -> None:
        tool_id = _identifier(part.get("callID") or part.get("id"))
        if tool_id is None:
            self._incomplete = True
            return
        key = (session_id, _identifier(part.get("messageID")), tool_id)
        previous = self._tools.get(key)
        if previous is None and not self._reserve_record():
            return
        state = _object(part.get("state"))
        child_id = _identifier(_object(state.get("metadata")).get("sessionId"))
        if (
            previous is not None
            and child_id is not None
            and previous.child_session_id not in (None, child_id)
        ):
            self._incomplete = True
        self._tools[key] = _ToolEvidence(
            session_id=session_id,
            active=state.get("status") not in ("completed", "error"),
            child_session_id=(child_id if part.get("tool") == "task" else None)
            or (previous.child_session_id if previous else None),
        )

    def _reserve_record(self) -> bool:
        if len(self._sessions) + len(self._messages) + len(self._tools) >= self._max_records:
            self._incomplete = True
            return False
        return True
