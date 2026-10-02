"""Best-effort, bounded Claude diagnostics, separate from session event delivery."""

from __future__ import annotations

import contextlib
import json
import re
import time
from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any, Final

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
)

if TYPE_CHECKING:
    from ..log_config import StructuredLogger
    from .base import BridgeEvent, TurnOutcome

PREVIEW_MAX_BYTES: Final = 2048
PREVIEW_MAX_NODES: Final = 128
PREVIEW_MAX_DEPTH: Final = 6
MIN_MCP_SECRET_LENGTH: Final = 8
REDACTED: Final = "[REDACTED]"
TRUNCATED: Final = "...[truncated]"
_SENSITIVE_KEY: Final = re.compile(
    r"pass|secret|credential|auth|cookie|private|key|token$|dsn|database_url|"
    r"^session_config$|^env$|^environment$|^headers$|^settings$",
    re.IGNORECASE,
)
_ASSIGNMENT: Final = re.compile(r"(?<![\w-])([\"']?[\w-]+[\"']?)\s*[:=]\s*")
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
        self.message_id: str | None = None
        self.agent_session_id: str | None = None
        self._started_at = 0.0
        self._assistant_messages: set[tuple[str | None, int]] = set()
        # A reused client can deliver a task's terminal update on a later prompt.
        self._task_parents: dict[str, str] = {}
        self._result_fields: dict[str, Any] = {}

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

    def begin(self, message_id: str, agent_session_id: str | None) -> None:
        self.message_id = message_id
        self.agent_session_id = agent_session_id
        self._started_at = time.monotonic()
        self._assistant_messages.clear()
        self._result_fields.clear()

    def _redact_text(self, text: str) -> str:
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
        for assignment in _ASSIGNMENT.finditer(window[:PREVIEW_MAX_BYTES]):
            if _SENSITIVE_KEY.search(assignment[1].strip("\"'")):
                value = _ASSIGNED_VALUE.match(window, assignment.end())
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
                name = str(key)[:PREVIEW_MAX_BYTES]
                safe_name = self._redact_text(name)
                if _SENSITIVE_KEY.search(name):
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
        return value

    def _preview(self, value: Any) -> str:
        # Tool output sometimes contains structured JSON, including credential keys.
        if isinstance(value, str) and len(value) <= PREVIEW_MAX_BYTES * 2:
            with contextlib.suppress(ValueError, RecursionError):
                value = json.loads(value)
        safe = self._redact(value, [PREVIEW_MAX_NODES])
        text = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False)
        return _bounded_text(text)

    def _write(self, event: str, *, level: str = "info", **fields: Any) -> None:
        fields = {
            "message_id": self.message_id,
            "agent_session_id": self.agent_session_id,
            **fields,
        }
        safe: dict[str, Any] = {}
        for key, value in fields.items():
            if value is None:
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
                fields.update(error_type=type(exc).__name__, error_preview=str(exc))
            self._write(event, level=level, **fields)
        except Exception:
            # Redaction, serialization or a logging handler failure is never a turn failure.
            pass

    def stderr(self, line: str) -> None:
        self.diagnostic("claude.sdk.stderr", diagnostic_preview=line)

    def message(self, message: Any, events: list[BridgeEvent]) -> None:
        try:
            native_id = getattr(message, "session_id", None)
            if isinstance(message, SystemMessage):
                native_id = native_id or message.data.get("session_id")
            if native_id:
                self.agent_session_id = native_id
            # Log every translated event before the first await of the event sink.
            for event in events:
                match event["type"]:
                    case "tool_call":
                        status = event["status"]
                        name = {"running": "started", "completed": "completed", "error": "failed"}[
                            status
                        ]
                        preview = (
                            {"args_preview": event["args"]}
                            if status == "running"
                            else {"output_preview": event["output"]}
                        )
                        self._write(
                            f"claude.tool.{name}",
                            tool=event["tool"],
                            call_id=event["callId"],
                            status=status,
                            parent_tool_use_id=event.get("taskCallId"),
                            **preview,
                        )
                    case "warning" | "error":
                        self._write(
                            "claude.provider.warning",
                            status=event["type"],
                            parent_tool_use_id=getattr(message, "parent_tool_use_id", None),
                            diagnostic_preview=event.get("message", event.get("error", "")),
                        )
                    case "context_compacted":
                        metadata = message.data.get("compact_metadata") or {}
                        self._write(
                            "claude.context.compacted",
                            trigger=metadata.get("trigger"),
                            pre_tokens=metadata.get("pre_tokens"),
                        )
            if isinstance(message, AssistantMessage) and not message.parent_tool_use_id:
                parts: list[str] = []
                remaining = PREVIEW_MAX_BYTES * 2 + 1
                for block in message.content:
                    if isinstance(block, TextBlock):
                        parts.append(block.text[:remaining])
                        remaining -= len(parts[-1])
                        if remaining <= 0:
                            break
                text = "".join(parts)
                key = (message.message_id, hash(text))
                if text and key not in self._assistant_messages:
                    self._assistant_messages.add(key)
                    self._write(
                        "claude.assistant.message",
                        assistant_message_id=message.message_id,
                        text_preview=text,
                    )
            elif isinstance(
                message, (TaskStartedMessage, TaskProgressMessage, TaskNotificationMessage)
            ):
                if message.tool_use_id:
                    self._task_parents[message.task_id] = message.tool_use_id
                fields: dict[str, Any] = {
                    "task_id": message.task_id,
                    "parent_tool_use_id": self._task_parents.get(message.task_id),
                }
                if isinstance(message, TaskStartedMessage):
                    fields.update(
                        description_preview=message.description, task_type=message.task_type
                    )
                else:
                    usage: Mapping[str, Any] = message.usage or {}
                    fields.update(
                        {
                            key: usage[key]
                            for key in ("total_tokens", "tool_uses", "duration_ms")
                            if key in usage
                        }
                    )
                    if isinstance(message, TaskNotificationMessage):
                        fields["status"] = message.status
                    else:
                        fields["last_tool_name"] = message.last_tool_name
                # Deliberately omit task summaries, result text and raw lifecycle data.
                self._write("claude." + message.subtype.replace("_", "."), **fields)
            elif isinstance(message, TaskUpdatedMessage):
                if message.status or message.patch.get("error"):
                    self._write(
                        "claude.task.updated",
                        task_id=message.task_id,
                        parent_tool_use_id=self._task_parents.get(message.task_id),
                        status=message.status,
                        error_preview=message.patch.get("error"),
                    )
            elif isinstance(message, ResultMessage):
                finish = next(event for event in events if event["type"] == "step_finish")
                tokens = finish.get("tokens") or {}
                self._result_fields = {
                    "sdk_status": message.subtype,
                    "sdk_is_error": message.is_error,
                    "sdk_duration_ms": message.duration_ms,
                    "sdk_duration_api_ms": message.duration_api_ms,
                    "num_turns": message.num_turns,
                    "total_cost_usd": message.total_cost_usd,
                    "tokens": {
                        key: value
                        for key, value in tokens.items()
                        if key in ("input", "output") and isinstance(value, int)
                    },
                }
                cache = tokens.get("cache") or {}
                if cache:
                    self._result_fields["tokens"]["cache"] = {
                        key: value for key, value in cache.items() if isinstance(value, int)
                    }
                if not self._result_fields["tokens"]:
                    self._result_fields["tokens"] = None
        except Exception:
            # Redaction, serialization or a logging handler failure is never a turn failure.
            pass

    def finish(self, outcome: TurnOutcome | None) -> None:
        try:
            status = "completed" if outcome and outcome.success else "failed"
            if outcome and outcome.cancelled:
                status = "cancelled"
            self._write(
                f"claude.turn.{status}",
                status=status,
                duration_s=round(time.monotonic() - self._started_at, 3),
                message_cost_usd=outcome.message_cost_usd if outcome else None,
                error_preview=outcome.error if outcome else None,
                **self._result_fields,
            )
        except Exception:
            pass
        finally:
            self.message_id = None
