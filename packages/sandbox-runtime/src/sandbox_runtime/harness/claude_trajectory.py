"""Best-effort Claude diagnostics, independent of SDK execution and UI delivery.

Every public observation encloses extraction as well as logging. SDK dataclasses
are not runtime-validated, so optional metadata must never fail a healthy turn.
Sanitization and handler isolation belong to the structured logging layer.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING, Any

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
)

if TYPE_CHECKING:
    from ..log_config import StructuredLogger
    from .base import TurnOutcome


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _number(value: Any) -> int | float | None:
    if type(value) not in (int, float):
        return None
    try:
        return value if math.isfinite(value) and value >= 0 else None
    except (OverflowError, ValueError):
        return None


def _seconds(value: Any) -> float | None:
    number = _number(value)
    return number / 1000 if number is not None else None


def _status(outcome: TurnOutcome | None, failure: BaseException | None = None) -> str:
    if isinstance(failure, asyncio.CancelledError) or (outcome is not None and outcome.cancelled):
        return "cancelled"
    return "completed" if outcome is not None and outcome.success else "failed"


def _emit(
    log: StructuredLogger, event: str, fields: dict[str, Any], *, warning: bool = False
) -> None:
    writer = log.warn if warning else log.info
    writer(
        event,
        harness="claude",
        **{key: value for key, value in fields.items() if value is not None},
    )


def observe_stderr(
    log: StructuredLogger, line: str, *, client_agent_session_id: str | None
) -> None:
    """Process-scoped stderr: the SDK supplies no trustworthy prompt identifier.

    The captured ID names the client's launch/resume context, not the current
    native session after a conversation reset or a concurrently running prompt.
    """
    with suppress(Exception):
        _emit(
            log,
            "claude.stderr",
            {
                "client_agent_session_id": client_agent_session_id,
                "stream": "stderr",
                "output": _text(line),
            },
        )


@contextmanager
def observe_turn(
    log: StructuredLogger,
    *,
    agent_session_id: str | None,
    message_id: str,
) -> Iterator[Callable[[TurnOutcome], None]]:
    """Observe an existing turn without changing scheduling or exception flow."""
    started_at = time.monotonic()
    outcome: TurnOutcome | None = None
    failure: BaseException | None = None

    def finished(value: TurnOutcome) -> None:
        nonlocal outcome
        outcome = value

    try:
        yield finished
    except BaseException as error:
        failure = error
        raise
    finally:
        with suppress(Exception):
            status = _status(outcome, failure)
            _emit(
                log,
                "claude.turn_end",
                {
                    "agent_session_id": agent_session_id,
                    "message_id": message_id,
                    "outcome": status,
                    "duration_seconds": time.monotonic() - started_at,
                    "message_cost_usd": _number(outcome.message_cost_usd) if outcome else None,
                    "error": _text(outcome.error) if outcome else str(failure) if failure else None,
                },
                warning=status == "failed",
            )


def observe_message(
    log: StructuredLogger,
    message: Any,
    *,
    agent_session_id: str | None,
    message_id: str,
    outcome: TurnOutcome | None = None,
    injected_turn: bool = False,
) -> None:
    """Project only selected SDK metadata; malformed projection is nonfatal."""
    with suppress(Exception):
        fields: dict[str, Any] = {"agent_session_id": agent_session_id, "message_id": message_id}
        if isinstance(
            message,
            (TaskStartedMessage, TaskProgressMessage, TaskNotificationMessage, TaskUpdatedMessage),
        ):
            fields["task_id"] = _text(message.task_id)
            if isinstance(message, TaskUpdatedMessage):
                patch = message.patch if isinstance(message.patch, Mapping) else {}
                status = message.status or patch.get("status")
                fields["status"] = (
                    status
                    if status in ("pending", "running", "paused", "completed", "failed", "killed")
                    else None
                )
                event = "claude.task_updated"
            else:
                fields["tool_use_id"] = _text(message.tool_use_id)
                if isinstance(message, TaskStartedMessage):
                    event = "claude.task_started"
                    fields.update(status="running", task_type=_text(message.task_type))
                else:
                    if isinstance(message, TaskNotificationMessage):
                        event = "claude.task_notification"
                        fields["status"] = _text(message.status)
                    else:
                        event = "claude.task_progress"
                        fields.update(
                            status="running", last_tool_name=_text(message.last_tool_name)
                        )
                    if isinstance(message.usage, Mapping):
                        for key in ("total_tokens", "tool_uses"):
                            value = message.usage.get(key)
                            if type(value) is int and _number(value) is not None:
                                fields[key] = value
                        fields["duration_seconds"] = _seconds(message.usage.get("duration_ms"))
            _emit(log, event, fields, warning=fields.get("status") == "failed")
            return
        if injected_turn:
            return
        if isinstance(message, AssistantMessage) and message.parent_tool_use_id is None:
            if not isinstance(message.content, (list, tuple)):
                return
            text = "".join(
                block.text
                for block in message.content
                if isinstance(block, TextBlock) and isinstance(block.text, str)
            )
            if text:
                fields.update(assistant_message_id=_text(message.message_id), text=text)
                _emit(log, "claude.assistant_message", fields)
        elif isinstance(message, ResultMessage) and outcome is not None:
            fields.update(
                outcome=_status(outcome),
                reason=_text(message.subtype),
                duration_seconds=_seconds(message.duration_ms),
                api_duration_seconds=_seconds(message.duration_api_ms),
                num_turns=_number(message.num_turns),
                error=_text(outcome.error),
            )
            _emit(log, "claude.result", fields, warning=fields["outcome"] == "failed")


def observe_events(
    log: StructuredLogger,
    events: Sequence[Mapping[str, Any]],
    *,
    agent_session_id: str | None,
    message_id: str,
) -> None:
    """Observe normalized events once, before delivery, without changing them."""
    with suppress(Exception):
        for event in events:
            with suppress(Exception):
                kind = event.get("type")
                fields: dict[str, Any] = {
                    "agent_session_id": agent_session_id,
                    "message_id": message_id,
                }
                if kind == "tool_call":
                    fields.update(
                        call_id=_text(event.get("callId")),
                        tool=_text(event.get("tool")),
                        status=_text(event.get("status")),
                        parent_tool_use_id=_text(event.get("taskCallId")),
                    )
                    # Task-tool args/results contain subagent prompts, summaries,
                    # descriptions and output paths. Metadata alone is intentional.
                    if fields["tool"] != "task":
                        if fields["status"] == "running":
                            fields["args_preview"] = event.get("args")
                        else:
                            fields["output"] = event.get("output")
                    _emit(log, "claude.tool_call", fields, warning=fields["status"] == "error")
                elif kind in ("context_compacted", "warning", "error"):
                    fields.update(
                        scope=_text(event.get("scope")),
                        detail=_text(event.get("message", event.get("error"))),
                    )
                    _emit(log, f"claude.{kind}", fields, warning=kind in ("warning", "error"))
                elif kind == "step_finish":
                    fields.update(
                        step_id=_text(event.get("stepId")),
                        reason=_text(event.get("reason")),
                        message_cost_usd=_number(event.get("messageCostUsd")),
                        tokens=event.get("tokens"),
                    )
                    _emit(log, "claude.step_finish", fields)
