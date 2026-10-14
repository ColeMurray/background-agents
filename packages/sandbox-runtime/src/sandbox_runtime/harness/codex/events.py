"""Pure, turn-correlated native event and token-usage projection."""

from __future__ import annotations

import json
import time
from typing import Any

from ..tool_results import content_text

# Even non-BMP characters expand to at most 12 JSON bytes each. Leave ample
# room for event identity/timestamps below the bridge's one-megabyte limit.
MAX_ASSISTANT_TEXT_CHARS = 64 * 1024
TEXT_UPDATE_INTERVAL_SECONDS = 0.1
TEXT_TRUNCATION_NOTICE = "\n\n[Response exceeds the display limit; remaining text omitted.]"
TOKEN_FIELDS = (
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
)
MAX_SAFE_TOKEN_COUNT = 2**53 - 1


def _token_counts(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    # Cache writes are optional in the pinned protocol; the other cumulative
    # fields must be present. Missing usage must not invent token counts.
    counts: dict[str, int] = {}
    for key in TOKEN_FIELDS:
        count = value.get(key, 0 if key == "cacheWriteInputTokens" else None)
        if type(count) is not int or not 0 <= count <= MAX_SAFE_TOKEN_COUNT:
            return None
        counts[key] = count
    if (
        counts["cachedInputTokens"] + counts["cacheWriteInputTokens"] > counts["inputTokens"]
        or counts["reasoningOutputTokens"] > counts["outputTokens"]
        or counts["totalTokens"] != counts["inputTokens"] + counts["outputTokens"]
    ):
        return None
    return counts


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


class CodexTurnEvents:
    def __init__(
        self,
        message_id: str,
        thread_id: str,
        turn_id: str,
        model: str,
        baseline: dict[str, int],
        *,
        baseline_known: bool = True,
    ) -> None:
        self.message_id, self.thread_id, self.turn_id = message_id, thread_id, turn_id
        self.model = model
        self.step_id = f"codex:{thread_id}:{turn_id}"
        normalized_baseline = _token_counts(
            baseline if baseline else dict.fromkeys(TOKEN_FIELDS, 0)
        )
        self.baseline = normalized_baseline or dict.fromkeys(TOKEN_FIELDS, 0)
        self.baseline_known = baseline_known and normalized_baseline is not None
        self.total = self.baseline.copy()
        self.text: dict[str, list[str]] = {}
        self._text_length = 0
        self._text_truncated = False
        self._text_dirty = False
        self._last_text_at: float | None = None
        self._last_text = ""
        self.status: str | None = None
        self.tokens: dict[str, Any] | None = None
        self.usage_valid = True
        self.has_usage = False

    def start(self) -> dict[str, Any]:
        return {
            "type": "step_start",
            "messageId": self.message_id,
            "stepId": self.step_id,
            "model": f"openai/{self.model}",
        }

    def finish(self) -> dict[str, Any]:
        return {
            "type": "step_finish",
            "messageId": self.message_id,
            "stepId": self.step_id,
            "model": f"openai/{self.model}",
            **({"tokens": self.tokens} if self.tokens is not None else {}),
            # Native turn events report tokens, not dollar costs.
            "cost": 0,
            "messageCostUsd": 0,
            "reason": self.status or "unknown",
        }

    def accept(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        method, params = frame.get("method"), frame.get("params")
        # Frames come from a separate process: tolerate null/non-object fields.
        if not isinstance(params, dict):
            return []
        if params.get("threadId") != self.thread_id:
            return []
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        turn_id = params.get("turnId") or turn.get("id")
        if turn_id != self.turn_id:
            return []
        if method == "turn/completed":
            self.status = turn.get("status")
            return self._text_event(force=True)
        if method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage")
            total = _token_counts(usage.get("total") if isinstance(usage, dict) else None)
            if (
                not self.usage_valid
                or total is None
                or any(total[k] < self.total[k] for k in TOKEN_FIELDS)
            ):
                return self._invalid_usage()
            counts = {k: total[k] - self.baseline[k] for k in TOKEN_FIELDS}
            if self.baseline_known and _token_counts(counts) is None:
                return self._invalid_usage()
            self.total = total
            self.has_usage = True
            if not self.baseline_known:
                # A contained cancellation can leave native history ahead of
                # the last observed total. Re-establish a baseline, not a bill.
                return [self.finish()]
            read, write = counts["cachedInputTokens"], counts["cacheWriteInputTokens"]
            # Native input includes cached reads and writes, native output
            # includes reasoning. Neutral buckets are disjoint.
            input_tokens = counts["inputTokens"] - read - write
            reasoning = counts["reasoningOutputTokens"]
            self.tokens = {
                "input": input_tokens,
                "output": counts["outputTokens"] - reasoning,
                "reasoning": reasoning,
                "cache": {"read": read, "write": write},
                "total": counts["totalTokens"],
            }
            return [self.finish()]
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
            elif kind in {
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "dynamicToolCall",
                "webSearch",
            }:
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
                output = _tool_output(kind, item)
                status = "running" if method == "item/started" else "completed"
                if item.get("status") in {"failed", "declined"} or item.get("success") is False:
                    status = "error"
                return [
                    {
                        "type": "tool_call",
                        "messageId": self.message_id,
                        "callId": f"codex:{self.turn_id}:{item_id}",
                        "tool": tool,
                        "args": args,
                        "status": status,
                        "output": output,
                    }
                ]
        # Raw reasoning and unrelated collaborator events are not assistant text.
        return []

    def _invalid_usage(self) -> list[dict[str, Any]]:
        self.usage_valid = False
        self.has_usage = False
        self.tokens = None
        return [self.finish()]

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
