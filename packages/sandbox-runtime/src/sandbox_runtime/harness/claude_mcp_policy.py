"""MCP tool allowlists rendered as Claude Agent SDK options."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from claude_agent_sdk import HookMatcher

from ..mcp_tool_access import mcp_name_segment, namespace_allowlists

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from claude_agent_sdk.types import (
        HookCallback,
        HookContext,
        HookEvent,
        HookInput,
        SyncHookJSONOutput,
    )


@dataclass(frozen=True)
class ClaudeToolPolicy:
    """Claude Agent SDK options for a session's MCP servers; ``hooks`` is empty
    when no server is restricted."""

    allowed_tools: list[str]
    disallowed_tools: list[str]
    hooks: dict[HookEvent, list[HookMatcher]] = field(default_factory=dict)


def claude_tool_policy(servers: Iterable[Mapping[str, Any]]) -> ClaudeToolPolicy:
    """Allow and deny rules for each server's tools, plus a guard hook.

    Under ``dontAsk`` a listed tool runs and any other is refused, unless another
    approval covers it. Approvals add up across sources: a ``mcp__docs__*`` rule
    in the session's Claude settings, or the wildcard of a server whose name
    overlaps (``mcp__docs__*`` also matches ``docs__extra``'s tools, since
    Claude Code splits names on ``__``), would approve unselected tools, so a
    ``PreToolUse`` hook refuses them; a hook's deny wins. That also leaves an
    unrestricted ``docs__extra`` next to a restricted ``docs`` without tools,
    since their tool names cannot be told apart. Claude Code removes a
    tool from context only when a deny rule names it, and the runtime does not
    know a server's other tool names, so they stay visible but are refused; an
    empty allowlist denies the whole server with a bare server rule.
    """
    allowlists = namespace_allowlists(servers)
    allowed: list[str] = []
    disallowed: list[str] = []
    for namespace, allowlist in allowlists.items():
        prefix = f"mcp__{namespace}"
        if allowlist is None:
            allowed.append(f"{prefix}__*")
        elif not allowlist:
            disallowed.append(prefix)
        else:
            allowed.extend(f"{prefix}__{mcp_name_segment(tool)}" for tool in allowlist)

    restricted = {ns: allowlist for ns, allowlist in allowlists.items() if allowlist is not None}
    if not restricted:
        return ClaudeToolPolicy(allowed, disallowed)
    guard = HookMatcher(hooks=[_claude_tool_guard(restricted)])
    return ClaudeToolPolicy(allowed, disallowed, {"PreToolUse": [guard]})


def _claude_tool_guard(restricted: dict[str, tuple[str, ...]]) -> HookCallback:
    """A ``PreToolUse`` hook refusing every ``mcp__<restricted>__*`` tool outside
    its allowlist."""
    prefixes = tuple(f"mcp__{namespace}__" for namespace in restricted)
    allowed = frozenset(
        f"mcp__{namespace}__{mcp_name_segment(tool)}"
        for namespace, allowlist in restricted.items()
        for tool in allowlist
    )

    async def guard(
        hook_input: HookInput, _tool_use_id: str | None, _context: HookContext
    ) -> SyncHookJSONOutput:
        tool_name = str(hook_input.get("tool_name", ""))
        if not tool_name.startswith(prefixes) or tool_name in allowed:
            return {}
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "This MCP tool is not enabled for this server.",
            }
        }

    return guard
