"""Reconcile persisted OpenCode messages after a prompt stream ends."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Protocol

from ..child_activity import MessageDisposition
from ..message_attribution import AssistantMessageDisposition

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from ..log_config import StructuredLogger
    from .opencode_client import OpenCodeClient
    from .opencode_stream import _PromptState


class PartHandler(Protocol):
    def __call__(
        self,
        state: _PromptState,
        part: dict[str, Any],
        delta: Any,
        *,
        is_subtask: bool = False,
    ) -> list[dict[str, Any]]: ...


def _message_created_epoch_ms(info: dict[str, Any]) -> int | None:
    """Read a finite `time.created`, or None when it is absent or malformed."""
    time_info = info.get("time")
    if not isinstance(time_info, dict):
        return None
    created = time_info.get("created")
    if isinstance(created, bool) or not isinstance(created, (int, float)):
        return None
    if not math.isfinite(created):
        return None
    return int(created)


async def recover_final_message_state(
    state: _PromptState,
    client: OpenCodeClient,
    log: StructuredLogger,
    handle_part: PartHandler,
) -> AsyncIterator[dict[str, Any]]:
    """Repair missed parent text and parent/child step costs from final API state.

    The parent attribution rule excludes prior turns and compaction summaries.
    Child history is considered only for task-associated sessions and messages
    authorized during this prompt or created after it started.
    """
    if not state.opencode_session_id:
        return

    try:
        messages = await client.get_messages(state.opencode_session_id)
        if messages is None:
            return

        for msg in messages:
            info = msg.get("info", {})
            if info.get("role") != "assistant":
                continue
            msg_id = info.get("id", "")
            disposition = state.attribution.assistant_disposition(
                msg_id,
                info.get("parentID", ""),
                is_summary=info.get("summary") is True,
                created_epoch_ms=_message_created_epoch_ms(info),
            )
            if disposition is not AssistantMessageDisposition.OUTPUT:
                continue

            state.costs.note_provider(msg_id, info.get("providerID"))
            for part in msg.get("parts", []):
                part_type = part.get("type", "")
                if part_type == "text":
                    text = part.get("text", "")
                    previously_sent = state.cumulative_text.get(part.get("id", ""), "")
                    if len(text) > len(previously_sent):
                        log.debug(
                            "bridge.final_text_update",
                            prev_len=len(previously_sent),
                            new_len=len(text),
                        )
                        for event in handle_part(state, part, None):
                            yield event
                elif part_type == "step-finish":
                    for event in handle_part(state, part, None):
                        yield event
                elif part_type == "tool" and part.get("tool") == "task":
                    tool_state = part.get("state", {})
                    metadata = (
                        tool_state.get("metadata", {}) if isinstance(tool_state, dict) else {}
                    )
                    child_id = metadata.get("sessionId") if isinstance(metadata, dict) else None
                    call_id = part.get("callID")
                    if isinstance(child_id, str) and isinstance(call_id, str):
                        state.child_activity.associate(child_id, call_id)

        for child_session_id in sorted(state.child_activity.tracked_session_ids):
            if not state.child_activity.task_for_activity(child_session_id):
                continue
            child_messages = await client.get_messages(child_session_id)
            for msg in child_messages or []:
                info = msg.get("info", {})
                msg_id = info.get("id", "")
                if info.get("role") != "assistant" or info.get("summary") is True or not msg_id:
                    continue
                created = _message_created_epoch_ms(info)
                if not state.attribution.is_assistant_allowed(msg_id) and (
                    created is None or created < int(state.start_time * 1000)
                ):
                    continue
                child_disposition = state.child_activity.authorize_or_queue_message(
                    child_session_id, msg_id
                )
                if child_disposition is not MessageDisposition.AUTHORIZED:
                    continue
                state.attribution.allow_assistant(msg_id)
                state.costs.note_provider(msg_id, info.get("providerID"))
                for part in msg.get("parts", []):
                    if part.get("type") == "step-finish":
                        for event in handle_part(state, part, None, is_subtask=True):
                            yield event
    except Exception as error:
        log.error("bridge.final_state_error", exc=error)
