"""Vendor-neutral tool results and helpers for tool response text."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx


@dataclass(frozen=True)
class ToolResult:
    text: str
    is_error: bool = False


def error_text(response: httpx.Response) -> str:
    """The control plane's ``error``/``message`` field, or the raw body when it has none."""
    text = response.text
    try:
        body = json.loads(text)
    except ValueError:
        return text
    if isinstance(body, dict):
        return str(body.get("error") or body.get("message") or text)
    return text


def content_text(content: Any) -> str:
    """Text of a tool result's content: a string, or the text items of a content list."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        # MCP content uses ``text``; Codex dynamic-tool results use ``inputText``.
        if isinstance(item, dict) and item.get("type") in {"text", "inputText"}:
            parts.append(str(item.get("text", "")))
    return "\n".join(parts)


def text_result(text: str) -> ToolResult:
    return ToolResult(text)


def error_result(text: str) -> ToolResult:
    return ToolResult(text, is_error=True)
