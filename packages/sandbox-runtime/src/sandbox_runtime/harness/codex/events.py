"""Pure, turn-correlated native event projection."""

from __future__ import annotations

import json
import re
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ..tool_results import content_text
from .usage import CodexUsage, PromptCost

if TYPE_CHECKING:
    from ...model_prices import ModelPrice

# Even non-BMP characters expand to at most 12 JSON bytes each. Leave ample
# room for event identity/timestamps below the bridge's one-megabyte limit.
MAX_ASSISTANT_TEXT_CHARS = 64 * 1024
TEXT_UPDATE_INTERVAL_SECONDS = 0.1
TEXT_TRUNCATION_NOTICE = "\n\n[Response exceeds the display limit; remaining text omitted.]"
TOOL_ITEM_KINDS = frozenset(
    {"commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"}
)
PLAN_STEP_STATUSES = {
    "pending": "pending",
    "inProgress": "in_progress",
    "completed": "completed",
}
# Native diagnostics can embed HTTP bodies; keep user-facing notices short.
MAX_DIAGNOSTIC_CHARS = 500
RATE_LIMIT_WARNING_PERCENT = 90
TURN_FAILED_MESSAGE = "Codex turn failed"
FAILURE_MESSAGES = {
    "unauthorized": (
        "OpenAI rejected this session's credential. Reconnect the OpenAI account in "
        "Settings (or check OPENAI_API_KEY) and try again."
    ),
    "usageLimitExceeded": "OpenAI usage limit reached; retry after it resets.",
    "rateLimitExceeded": "OpenAI rate limit reached; retry shortly.",
    "serverOverloaded": "OpenAI is overloaded right now; retry shortly.",
    "contextWindowExceeded": (
        "This conversation no longer fits in the model's context window; start a new session."
    ),
}
AUTH_RECOVERY_SUMMARIES = {
    "modelProvider/authRecoveryStarted": "Codex is recovering {} authentication",
    "modelProvider/authRecoveryCompleted": "Codex finished recovering {} authentication",
}


# Native text is free-form (it can embed vendor HTTP bodies), so credential
# shapes are masked before anything reaches the persisted session timeline.
SECRET_PATTERNS = (
    (re.compile(r"(?i)\b(bearer|basic)\s+[^\s\"',;]+"), r"\1 ***"),
    (
        re.compile(
            r"(?i)\b([\w-]*(?:api[_-]?key|token|secret|password|authorization|cookie)[\w-]*)"
            r"(\"?\s*[:=]\s*\"?)[^\s\"',;}]+"
        ),
        r"\1\2***",
    ),
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]*"), "***"),
    (re.compile(r"\bsk-[\w-]{8,}"), "***"),
    # Opaque credentials of unknown shape: long runs that include a digit.
    (re.compile(r"(?=[A-Za-z0-9_+=-]*[0-9])[A-Za-z0-9_+=-]{32,}"), "***"),
)


def _clip(text: str) -> str:
    """Redacted, whitespace-collapsed, and bounded native diagnostic text."""
    # Pre-bounding keeps redaction cheap; masking only shortens the text.
    text = " ".join(text[: 4 * MAX_DIAGNOSTIC_CHARS].split())
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    if len(text) <= MAX_DIAGNOSTIC_CHARS:
        return text
    return text[: MAX_DIAGNOSTIC_CHARS - 1] + "…"


def _with_detail(summary: str, detail: Any) -> str:
    return f"{summary}: {detail}" if isinstance(detail, str) and detail.strip() else summary


def _native_message(error: Any) -> str:
    message = error.get("message") if isinstance(error, dict) else None
    return _clip(message) if isinstance(message, str) else ""


def failure_message(error: Any) -> str:
    """An actionable message for a failed turn's native ``TurnError``."""
    info = error.get("codexErrorInfo") if isinstance(error, dict) else None
    mapped = FAILURE_MESSAGES.get(info) if isinstance(info, str) else None
    return mapped or _native_message(error) or TURN_FAILED_MESSAGE


def _merge_sparse(previous: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """Apply a sparse update: an omitted or null field keeps its prior value."""
    merged = dict(previous)
    for key, value in update.items():
        if value is None:
            continue
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            value = _merge_sparse(merged[key], value)
        merged[key] = value
    return merged


def _window_label(name: str, window: dict[str, Any]) -> str:
    minutes = window.get("windowDurationMins")
    if type(minutes) is int and minutes > 0:
        for size, unit in ((24 * 60, "day"), (60, "hour"), (1, "minute")):
            if minutes % size == 0:
                return f"{minutes // size}-{unit}"
    return name


def _resets(window: dict[str, Any]) -> str:
    resets_at = window.get("resetsAt")
    if type(resets_at) is not int:
        return ""
    try:
        moment = datetime.fromtimestamp(resets_at, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return ""
    return f", resets {moment:%Y-%m-%d %H:%M} UTC"


def tool_call_event(
    method: str, item: dict[str, Any], message_id: str, turn_id: str
) -> dict[str, Any] | None:
    """Project a native tool item lifecycle notification onto a bridge ``tool_call``."""
    kind = item.get("type")
    if kind not in TOOL_ITEM_KINDS:
        return None
    tool = {
        "commandExecution": "bash",
        "fileChange": "apply_patch",
        "webSearch": "websearch",
    }.get(kind)
    if not tool:
        namespace = item.get("namespace") or item.get("server")
        tool = str(item.get("tool") or "tool")
        if namespace and namespace != "oi":
            tool = f"mcp__{namespace}__{tool}"
    args = item.get("arguments") or {
        key: item[key] for key in ("command", "cwd", "changes", "query") if key in item
    }
    if kind == "webSearch":
        action = item.get("action") or {}
        if action.get("type") in {"openPage", "findInPage"}:
            tool = "webfetch"
            fields = ("url", "pattern")
        else:
            fields = ("query", "queries")
        args = {key: action[key] for key in fields if action.get(key) is not None}
        if tool == "websearch" and not args.get("query"):
            args["query"] = item.get("query", "")
    # Transport sizing belongs to EventForwarder (event_size.truncate_tool_call).
    status = "running" if method == "item/started" else "completed"
    if item.get("status") in {"failed", "declined"} or item.get("success") is False:
        status = "error"
    return {
        "type": "tool_call",
        "messageId": message_id,
        "callId": f"codex:{turn_id}:{item.get('id')}",
        "tool": tool,
        "args": args,
        "status": status,
        "output": _tool_output(kind, item),
    }


def _tool_output(kind: str, item: dict[str, Any]) -> str:
    """Project a native tool result onto the bridge's text-output contract."""
    if kind == "dynamicToolCall":
        return content_text(item.get("contentItems"))
    if kind == "mcpToolCall":
        error = item.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        result = item.get("result")
        if isinstance(result, dict):
            return content_text(result.get("content"))
        return content_text(result)
    output = item.get("aggregatedOutput") or item.get("result") or ""
    return output if isinstance(output, str) else json.dumps(output)


def _plan_todos(plan: Any) -> list[dict[str, str]]:
    """Project native plan steps onto the web task list's todowrite contract."""
    if not isinstance(plan, list):
        return []
    return [
        {
            "content": step["step"],
            # The web task list treats unknown statuses as pending.
            "status": PLAN_STEP_STATUSES.get(str(step.get("status")), "pending"),
        }
        for step in plan
        if isinstance(step, dict) and isinstance(step.get("step"), str)
    ]


class CodexRateLimits:
    """Account-level quota state, kept across turns, that warns only on escalation.

    Rolling updates are sparse, so each merges into its own quota's retained
    snapshot. A window that drops below the threshold (recovery, or a reset into
    a new period) re-arms its warning; rolling updates within a state stay quiet.
    """

    def __init__(self) -> None:
        self._snapshots: dict[str | None, dict[str, Any]] = {}
        self._levels: dict[str | None, dict[str, Any]] = {}
        self._limit_id: str | None = None

    def update(self, snapshot: Any) -> str | None:
        """The warning this update warrants, if any."""
        if not isinstance(snapshot, dict):
            return None
        if isinstance(snapshot.get("limitId"), str):
            self._limit_id = snapshot["limitId"]
        # An update without a limitId belongs to the last identified quota.
        quota = self._limit_id
        merged = _merge_sparse(self._snapshots.get(quota, {}), snapshot)
        self._snapshots[quota] = merged
        previous = self._levels.get(quota, {})
        levels: dict[str, Any] = {}
        parts = []
        reached = merged.get("rateLimitReachedType")
        if isinstance(reached, str):
            levels["reached"] = reached
            parts.append(reached.replace("_", " "))
        if merged.get("spendControlReached") is True:
            levels["spendControl"] = 1
            parts.append("spend control limit reached")
        for name in ("primary", "secondary"):
            window = merged.get(name)
            if not isinstance(window, dict):
                continue
            used = window.get("usedPercent")
            if type(used) is not int or used < RATE_LIMIT_WARNING_PERCENT:
                continue
            # Near is 1 and reached is 2; dipping back to near does not re-arm.
            levels[name] = max(2 if used >= 100 else 1, previous.get(name, 0))
            parts.append(f"{_window_label(name, window)} limit {used}% used{_resets(window)}")
        self._levels[quota] = levels
        escalated = any(
            value != previous.get(level) if level == "reached" else value > previous.get(level, 0)
            for level, value in levels.items()
        )
        return _clip(f"OpenAI {'; '.join(parts)}.") if escalated else None


class CodexTurnEvents:
    def __init__(
        self,
        message_id: str,
        thread_id: str,
        turn_id: str,
        model: str,
        baseline: dict[str, int],
        *,
        rate_limits: CodexRateLimits,
        baseline_known: bool = True,
        price: ModelPrice | None = None,
        unpriced_warning: str | None = None,
    ) -> None:
        self.message_id, self.thread_id, self.turn_id = message_id, thread_id, turn_id
        self.model = model
        self.step_id = f"codex:{thread_id}:{turn_id}"
        # Sub-agents charge the same prompt cost; see CodexSubagents.
        self.usage = CodexUsage(
            PromptCost(price, unpriced_warning), model, baseline, baseline_known=baseline_known
        )
        self.text: dict[str, list[str]] = {}
        self._text_length = 0
        self._text_truncated = False
        self._text_dirty = False
        self._last_text_at: float | None = None
        self._last_text = ""
        self.status: str | None = None
        # Actionable detail for a failed turn; set once, with its ``error`` event.
        self.error: str | None = None
        # A non-retried native error, used if ``turn/completed`` omits its own.
        self._fatal_error: dict[str, Any] | None = None
        self._warned: set[str] = set()
        self.rate_limits = rate_limits
        self._plan_updates = 0

    def start(self) -> dict[str, Any]:
        return {
            "type": "step_start",
            "messageId": self.message_id,
            "stepId": self.step_id,
            "model": f"openai/{self.model}",
        }

    @property
    def message_cost_usd(self) -> float:
        """Priced cost of the requests observed so far for this prompt, sub-agents included."""
        return self.usage.prompt_cost.usd

    def finish(self) -> dict[str, Any]:
        return {
            "type": "step_finish",
            "messageId": self.message_id,
            "stepId": self.step_id,
            "model": f"openai/{self.model}",
            **({"tokens": self.usage.tokens} if self.usage.tokens is not None else {}),
            # An absent cost marks a turn that could not be priced.
            **({"cost": cost} if (cost := self.usage.step_cost_usd) is not None else {}),
            "messageCostUsd": self.message_cost_usd,
            "reason": self.status or "unknown",
        }

    def accept(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        method, params = frame.get("method"), frame.get("params")
        # Frames come from a separate process: tolerate null/non-object fields.
        if not isinstance(params, dict):
            return []
        # Account- and process-level notices carry no turn (or thread) identity.
        if method == "account/rateLimits/updated":
            message = self.rate_limits.update(params.get("rateLimits"))
            return [{"type": "warning", "scope": "provider", "message": message}] if message else []
        if method == "configWarning":
            return self._warning(params.get("summary"))
        if method == "warning" and params.get("threadId") in (None, self.thread_id):
            return self._warning(params.get("message"))
        if params.get("threadId") != self.thread_id:
            return []
        if method == "guardianWarning":
            return self._warning(params.get("message"))
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        turn_id = params.get("turnId") or turn.get("id")
        if turn_id != self.turn_id:
            return []
        if method == "turn/completed":
            self.status = turn.get("status")
            events = self._text_event(force=True)
            if self.status == "failed":
                error = turn.get("error")
                events.extend(self._failed(error if isinstance(error, dict) else self._fatal_error))
            return events
        if method == "error":
            error = params.get("error")
            if params.get("willRetry") is True:
                return self._warning(
                    _with_detail("Codex hit an error and is retrying", _native_message(error))
                )
            # The terminal ``turn/completed`` reports the failure exactly once.
            if isinstance(error, dict):
                self._fatal_error = error
            return []
        if method == "model/rerouted":
            to_model, reason = params.get("toModel"), params.get("reason")
            if not isinstance(to_model, str):
                return []
            message = f"Codex switched this turn from {params.get('fromModel')} to {to_model}"
            if isinstance(reason, str):
                message += f" ({re.sub(r'(?<!^)(?=[A-Z])', ' ', reason).lower()})"
            return self.warnings([message, *self.usage.ran(to_model)])
        if method in AUTH_RECOVERY_SUMMARIES:
            provider = params.get("provider") or "model provider"
            summary = AUTH_RECOVERY_SUMMARIES[method].format(provider)
            return self._warning(_with_detail(summary, params.get("message")))
        if method == "thread/tokenUsage/updated":
            return [*self.warnings(self.usage.update(params.get("tokenUsage"))), self.finish()]
        if method == "turn/plan/updated":
            # Each update is a distinct call: upserts keep a callId's first
            # timeline slot, and the task list shows the latest todowrite.
            self._plan_updates += 1
            explanation = params.get("explanation")
            return [
                {
                    "type": "tool_call",
                    "messageId": self.message_id,
                    "callId": f"codex:{self.turn_id}:plan:{self._plan_updates}",
                    "tool": "todowrite",
                    "args": {"todos": _plan_todos(params.get("plan"))},
                    "status": "completed",
                    "output": explanation if isinstance(explanation, str) else "",
                }
            ]
        if method == "item/agentMessage/delta":
            item_id = str(params.get("itemId"))
            self._record_text(item_id, str(params.get("delta", "")))
            return self._text_event()
        if method in {"item/started", "item/completed"}:
            item = params.get("item") if isinstance(params.get("item"), dict) else {}
            kind, item_id = item.get("type"), str(item.get("id"))
            if kind == "agentMessage":
                if method == "item/completed":
                    self._record_text(item_id, str(item.get("text", "")), replace=True)
                    return self._text_event(force=True)
            elif kind == "contextCompaction":
                if method == "item/started":
                    return []
                # One boundary: flush pre-compaction text, mark the boundary, then
                # start a fresh segment. The turn-wide display budget is retained.
                events = self._text_event(force=True)
                events.append({"type": "context_compacted", "messageId": self.message_id})
                self.text = {}
                self._last_text = ""
                return events
            elif event := tool_call_event(method, item, self.message_id, self.turn_id):
                return [event]
        # Raw reasoning is not assistant text; sub-agent items belong to CodexSubagents.
        return []

    def fail_pending(self) -> list[dict[str, Any]]:
        """Report a recorded non-retried native error when ``turn/completed`` never arrives."""
        return self._failed(self._fatal_error) if self._fatal_error is not None else []

    def _failed(self, error: Any) -> list[dict[str, Any]]:
        if self.error is not None:
            return []
        self.error = failure_message(error)
        return [{"type": "error", "error": self.error, "messageId": self.message_id}]

    def warnings(self, messages: list[str]) -> list[dict[str, Any]]:
        """Provider warnings for this prompt, each reported once."""
        return [event for message in messages for event in self._warning(message)]

    def _warning(self, message: Any) -> list[dict[str, Any]]:
        if not isinstance(message, str) or not message.strip():
            return []
        message = _clip(message)
        if message in self._warned:
            return []
        self._warned.add(message)
        return [{"type": "warning", "scope": "provider", "message": message}]

    def _record_text(self, item_id: str, text: str, *, replace: bool = False) -> None:
        previous_length = sum(map(len, self.text.get(item_id, ()))) if replace else 0
        separator_length = 2 if self.text and item_id not in self.text else 0
        remaining = max(
            0, MAX_ASSISTANT_TEXT_CHARS - self._text_length + previous_length - separator_length
        )
        if len(text) > remaining and not self._text_truncated:
            self._text_truncated = self._text_dirty = True
        retained = text[:remaining]
        if not retained and (not replace or item_id not in self.text):
            return
        if item_id not in self.text:
            self.text[item_id] = []
            self._text_length += separator_length
        if replace:
            self.text[item_id] = []
            self._text_length -= previous_length
        if retained:
            self.text[item_id].append(retained)
        self._text_length += len(retained)
        self._text_dirty = True

    def _text_event(self, *, force: bool = False) -> list[dict[str, Any]]:
        if not self._text_dirty:
            return []
        now = time.monotonic()
        if (
            not force
            and self._last_text_at is not None
            and now - self._last_text_at < TEXT_UPDATE_INTERVAL_SECONDS
        ):
            return []
        text = "\n\n".join("".join(parts) for parts in self.text.values())
        if self._text_truncated:
            text += TEXT_TRUNCATION_NOTICE
        self._text_dirty = False
        if text == self._last_text:
            return []
        self._last_text_at = now
        self._last_text = text
        return [{"type": "token", "messageId": self.message_id, "content": text}]
