"""Best-effort, bounded Claude diagnostics, separate from session event delivery."""

from __future__ import annotations

import contextlib
import json
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from contextvars import Token

    from ..log_config import StructuredLogger
    from .base import TurnOutcome
    from .claude_translate import ClaudeTranslation, SdkTurnResult

PREVIEW_MAX_BYTES: Final = 2048
TRUNCATED: Final = "...[truncated]"


def _bounded_text(text: str) -> str:
    encoded = text[: PREVIEW_MAX_BYTES + 1].encode("utf-8", errors="replace")
    if len(encoded) > PREVIEW_MAX_BYTES:
        return (
            encoded[: PREVIEW_MAX_BYTES - len(TRUNCATED)].decode("utf-8", errors="ignore")
            + TRUNCATED
        )
    return encoded.decode("utf-8")


@dataclass
class _LogTurn:
    message_id: str
    agent_session_id: str | None
    started_at: float = field(default_factory=time.monotonic)
    result: SdkTurnResult | None = None


class ClaudeTrajectoryLogger:
    """Uses the bridge logger's context; never mutates SDK messages or wire events."""

    def __init__(self, log: StructuredLogger) -> None:
        self.log = log
        self._turn: ContextVar[_LogTurn | None] = ContextVar("claude_log_turn", default=None)
        self._agent_session_id: str | None = None

    def begin(self, message_id: str, agent_session_id: str | None) -> Token[_LogTurn | None]:
        turn = _LogTurn(message_id, agent_session_id)
        if self._agent_session_id is None:
            self._agent_session_id = agent_session_id
        return self._turn.set(turn)

    def reset_session(self, agent_session_id: str | None) -> None:
        self._agent_session_id = agent_session_id

    def _preview(self, value: Any) -> str:
        if isinstance(value, str):
            return _bounded_text(value)
        text = ""
        for chunk in json.JSONEncoder(ensure_ascii=False).iterencode(value):
            text += chunk[: PREVIEW_MAX_BYTES + 1 - len(text)]
            if len(text) > PREVIEW_MAX_BYTES:
                break
        return _bounded_text(text)

    def _write(
        self, event: str, *, level: str = "info", exc: BaseException | None = None, **fields: Any
    ) -> None:
        turn = self._turn.get()
        fields = {
            "message_id": turn.message_id if turn else None,
            "agent_session_id": turn.agent_session_id if turn else self._agent_session_id,
            **fields,
        }
        output = {
            key: value
            if isinstance(value, (bool, int, float)) or key == "tokens"
            else self._preview(value)
            for key, value in fields.items()
            if value is not None
        }
        if exc is not None:
            output["exc"] = exc
        getattr(self.log, level)(event, **output)

    def diagnostic(
        self, event: str, *, level: str = "info", exc: BaseException | None = None, **fields: Any
    ) -> None:
        # Serialization or logging failures must never interrupt agent execution.
        with contextlib.suppress(Exception):
            self._write(event, level=level, exc=exc, **fields)

    def stderr(self, line: str) -> None:
        # The connection-lived reader inherits its first prompt's context, but
        # stderr has no turn ID and may arrive after that prompt has completed.
        self.diagnostic(
            "claude.sdk.stderr",
            message_id=None,
            agent_session_id=self._agent_session_id,
            diagnostic_preview=line,
        )

    def emit(self, translation: ClaudeTranslation) -> None:
        turn = self._turn.get()
        if translation.agent_session_id:
            self._agent_session_id = translation.agent_session_id
            if turn:
                turn.agent_session_id = translation.agent_session_id
        if turn and translation.result is not None:
            turn.result = translation.result
        for record in translation.records:
            self.diagnostic(record.event, **record.fields)

    def finish(self, outcome: TurnOutcome | None, token: Token[_LogTurn | None]) -> None:
        turn = self._turn.get()
        try:
            if turn is None:
                return
            status = "completed" if outcome and outcome.success else "failed"
            if outcome and outcome.cancelled:
                status = "cancelled"
            result = turn.result
            self._write(
                f"claude.turn.{status}",
                status=status,
                duration_s=round(time.monotonic() - turn.started_at, 3),
                message_cost_usd=outcome.message_cost_usd if outcome else None,
                error_preview=outcome.error if outcome else None,
                sdk_status=result.status if result else None,
                sdk_is_error=result.is_error if result else None,
                sdk_duration_ms=result.duration_ms if result else None,
                sdk_duration_api_ms=result.duration_api_ms if result else None,
                num_turns=result.num_turns if result else None,
                total_cost_usd=result.total_cost_usd if result else None,
                tokens=result.tokens if result else None,
            )
        except Exception:
            pass
        finally:
            self._turn.reset(token)
