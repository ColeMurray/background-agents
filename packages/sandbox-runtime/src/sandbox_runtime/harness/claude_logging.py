"""Best-effort, bounded Claude diagnostics, separate from session event delivery."""

from __future__ import annotations

import contextlib
import json
import re
import time
import traceback
from collections import deque
from collections.abc import Iterable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

from ..constants import USER_SECRET_KEYS_ENV_VAR

if TYPE_CHECKING:
    from contextvars import Token

    from ..log_config import StructuredLogger
    from .base import TurnOutcome
    from .claude_translate import ClaudeTranslation, SdkTurnResult

PREVIEW_MAX_BYTES: Final = 2048
PREVIEW_MAX_NODES: Final = 128
PREVIEW_MAX_DEPTH: Final = 6
MIN_MCP_SECRET_LENGTH: Final = 8
MAX_TRACEBACK_FRAMES: Final = 8
CONTENT_OMITTED: Final = "[content omitted: secret inventory unavailable]"
REDACTED: Final = "[REDACTED]"
TRUNCATED: Final = "...[truncated]"
_SENSITIVE_KEY: Final = re.compile(
    r"pass|secret|credential|auth|cookie|private|key|token$|dsn|database_url|"
    r"^session_config$|^env$|^environment$|^headers$|^settings$",
    re.IGNORECASE,
)
_ASSIGNMENT: Final = re.compile(r"(?<![\w-])([\"']?[\w-]+[\"']?)\s*[:=]\s*")
_CLI_FLAG: Final = re.compile(r"(?<![\w-])[\"']?--?([\w-]+)[\"']?(?:\s*=\s*|(?:\s|\\\r?\n)+)")
_CLI_VALUE: Final = re.compile(
    r"(?:\"(?:\\[\s\S]|[^\"\\])*(?:\"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|"
    r"\\[\s\S]|[^\s;&|\"'\\])+"
)
_ASSIGNED_VALUE: Final = re.compile(
    r"\"(?:\\.|[^\"\\])*(?:\"|$)|'(?:\\.|[^'\\])*(?:'|$)|"
    r"[\[{][\s\S]*|(?:(?:Bearer|Basic)\s+)?[^\s,;]+",
    re.IGNORECASE,
)
_AUTH_VALUE: Final = re.compile(r"\b(?:Bearer|Basic)\s+([^\s\"',;]+)", re.IGNORECASE)
_URL_AUTHORITY: Final = re.compile(r"(?<![\w+.-])[a-z][a-z0-9+.-]*://([^/\s\"']*)", re.IGNORECASE)


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

    def __init__(
        self,
        log: StructuredLogger,
        environ: Mapping[str, str],
        mcp_servers: tuple[Mapping[str, Any], ...],
        auth_token: str | None,
    ) -> None:
        self.log = log
        self._secrets: set[str] = set()
        self.content_logging = False
        with contextlib.suppress(ValueError, TypeError):
            names = json.loads(environ.get(USER_SECRET_KEYS_ENV_VAR, "null"))
            if isinstance(names, list) and all(
                isinstance(name, str) and name in environ for name in names
            ):
                self.add_credentials(environ[name] for name in names)
                self.content_logging = True
        self.add_credentials(
            value
            for key, value in environ.items()
            if _SENSITIVE_KEY.search(key) and not key.endswith(("_MANAGED", "_ENABLED", "_MODE"))
        )
        self.add_credentials([auth_token] if auth_token else [])
        for server in mcp_servers:
            for key in ("headers", "env"):
                self.add_credentials(
                    value
                    for name, value in (server.get(key) or {}).items()
                    if isinstance(value, str)
                    and (len(value) >= MIN_MCP_SECRET_LENGTH or _SENSITIVE_KEY.search(name))
                )
        self._turn: ContextVar[_LogTurn | None] = ContextVar("claude_log_turn", default=None)
        self._agent_session_id: str | None = None

    def add_credentials(self, values: Iterable[str]) -> None:
        for value in values:
            if not isinstance(value, str) or not value:
                continue
            # A private key may be echoed one line at a time, or JSON-escaped.
            for part in (value, *value.splitlines()):
                if part:
                    self._secrets.update(
                        (part, json.dumps(part)[1:-1], json.dumps(part, ensure_ascii=False)[1:-1])
                    )

    def begin(self, message_id: str, agent_session_id: str | None) -> Token[_LogTurn | None]:
        turn = _LogTurn(message_id, agent_session_id)
        if self._agent_session_id is None:
            self._agent_session_id = agent_session_id
        return self._turn.set(turn)

    def reset_session(self, agent_session_id: str | None) -> None:
        self._agent_session_id = agent_session_id

    def _redact_text(self, text: str, *, secrets_only: bool = False) -> str:
        # Look ahead beyond the retained prefix so credentials crossing its edge
        # are removed whole. Long credentials need only a prefix match: nothing
        # beyond the retained window will be logged.
        window = text[: PREVIEW_MAX_BYTES * 2]
        spans: list[tuple[int, int]] = []
        for secret in self._secrets:
            prefix = secret[:PREVIEW_MAX_BYTES]
            start = window.find(prefix)
            while 0 <= start < PREVIEW_MAX_BYTES:
                spans.append((start, min(start + len(secret), PREVIEW_MAX_BYTES)))
                start = window.find(prefix, start + len(prefix))
        if not secrets_only:
            for assignment in _ASSIGNMENT.finditer(window[:PREVIEW_MAX_BYTES]):
                if _SENSITIVE_KEY.search(assignment[1].strip("\"'")):
                    if ":" in assignment[0]:
                        # Header schemes and cookie pairs have no single-token grammar.
                        end = window.find("\n", assignment.end())
                        spans.append(
                            (
                                assignment.end(),
                                min(end if end >= 0 else len(window), PREVIEW_MAX_BYTES),
                            )
                        )
                    else:
                        value = _ASSIGNED_VALUE.match(window, assignment.end())
                        if value:
                            spans.append((value.start(), min(value.end(), PREVIEW_MAX_BYTES)))
            for flag in _CLI_FLAG.finditer(window[:PREVIEW_MAX_BYTES]):
                if _SENSITIVE_KEY.search(flag[1]):
                    value = _CLI_VALUE.match(window, flag.end())
                    if value:
                        spans.append((value.start(), min(value.end(), PREVIEW_MAX_BYTES)))
            for auth in _AUTH_VALUE.finditer(window):
                spans.append((auth.start(1), min(auth.end(1), PREVIEW_MAX_BYTES)))
            for url in _URL_AUTHORITY.finditer(window):
                authority = url[1]
                if "@" in authority:
                    spans.append(
                        (url.start(1), min(url.start(1) + authority.rfind("@"), PREVIEW_MAX_BYTES))
                    )
                elif ":" in authority and url.end() == len(window) and len(text) > len(window):
                    # A credential-bearing authority may continue beyond the lookahead.
                    spans.append((url.start(1), PREVIEW_MAX_BYTES))
        safe = ""
        end = 0
        for start, stop in sorted(spans):
            if stop <= end or start >= PREVIEW_MAX_BYTES:
                continue
            if start >= end:
                safe += text[end:start] + REDACTED
            end = stop
        safe += text[end:PREVIEW_MAX_BYTES]
        return safe + TRUNCATED if len(text) > PREVIEW_MAX_BYTES else safe

    def _redact(self, value: Any, remaining: list[int], depth: int = 0) -> Any:
        if remaining[0] <= 0:
            return TRUNCATED
        remaining[0] -= 1
        if depth > PREVIEW_MAX_DEPTH:
            return TRUNCATED
        if isinstance(value, Mapping):
            result: dict[str, Any] = {}
            for key, item in value.items():
                if remaining[0] <= 0:
                    result[TRUNCATED] = TRUNCATED
                    break
                name = str(key)
                safe_name = self._redact_text(name)
                if _SENSITIVE_KEY.search(name[:PREVIEW_MAX_BYTES]):
                    result[safe_name] = REDACTED
                    remaining[0] -= 1
                else:
                    result[safe_name] = self._redact(item, remaining, depth + 1)
            return result
        if isinstance(value, (list, tuple)):
            items: list[Any] = []
            for item in value:
                if remaining[0] <= 0:
                    items.append(TRUNCATED)
                    break
                items.append(self._redact(item, remaining, depth + 1))
            return items
        if isinstance(value, str):
            return self._redact_text(value)
        if value is None or isinstance(value, (bool, int, float)):
            text = json.dumps(value)
            safe = self._redact_text(text)
            return safe if safe != text else value
        return value

    def _preview(self, value: Any) -> str:
        # Tool output sometimes contains structured JSON, including credential keys.
        if isinstance(value, str):
            safe_text = self._redact_text(value)
            if safe_text != value:
                return _bounded_text(safe_text)
            if len(value) <= PREVIEW_MAX_BYTES * 2:
                with contextlib.suppress(ValueError, RecursionError):
                    value = json.loads(value)
        safe = self._redact(value, [PREVIEW_MAX_NODES])
        text = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False)
        # Structured arguments can reconstruct a JSON-valued credential during
        # preview encoding, even after their individual leaves were scrubbed.
        text = self._redact_text(text, secrets_only=True)
        return _bounded_text(text)

    def _write(self, event: str, *, level: str = "info", **fields: Any) -> None:
        turn = self._turn.get()
        fields = {
            "message_id": turn.message_id if turn else None,
            "agent_session_id": turn.agent_session_id if turn else self._agent_session_id,
            **fields,
        }
        safe: dict[str, Any] = {}
        for key, value in fields.items():
            if value is None:
                continue
            if (key.endswith("_preview") or key == "error_message") and not self.content_logging:
                safe[key] = CONTENT_OMITTED
                continue
            if isinstance(value, (bool, int, float)) or key == "tokens":
                safe[key] = value
            elif key in (
                "message_id",
                "agent_session_id",
                "assistant_message_id",
                "call_id",
                "parent_tool_use_id",
                "task_id",
                "previous_session_id",
            ):
                # Runtime/SDK identities must retain short substrings for correlation.
                safe[key] = _bounded_text(str(value))
            else:
                safe[key] = self._preview(value)
        getattr(self.log, level)(event, **safe)

    def diagnostic(
        self, event: str, *, level: str = "info", exc: BaseException | None = None, **fields: Any
    ) -> None:
        try:
            if exc is not None:
                frames = deque(traceback.walk_tb(exc.__traceback__), maxlen=MAX_TRACEBACK_FRAMES)
                fields.update(
                    error_type=type(exc).__name__,
                    error_message=str(exc),
                    error_stack="\n".join(
                        f"File {frame.f_code.co_filename!r}, line {line}, in {frame.f_code.co_name}"
                        for frame, line in frames
                    ),
                )
            self._write(event, level=level, **fields)
        except Exception:
            # Redaction, serialization or a logging handler failure is never a turn failure.
            pass

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
