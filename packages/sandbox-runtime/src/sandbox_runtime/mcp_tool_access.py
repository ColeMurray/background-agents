"""Per-server MCP tool allowlists, rendered for each agent harness.

A server config's ``toolAllowlist`` names the server's own tools the agent may
use. Absent or ``None`` allows every tool; a list allows only those names, so
an empty list allows none.
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from claude_agent_sdk import HookMatcher

if TYPE_CHECKING:
    from collections.abc import Collection, Iterable, Mapping

    from claude_agent_sdk.types import (
        HookCallback,
        HookContext,
        HookEvent,
        HookInput,
        SyncHookJSONOutput,
    )

    Allowlists = dict[str, tuple[str, ...] | None]

# OpenCode and Claude Code both build an MCP tool's name from the server and tool
# names with every character outside this set replaced by "_".
_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]")

# OpenCode's built-in tools (``GET /experimental/tool/ids``) at OpenCode
# OPENCODE_BUILTIN_TOOL_IDS_VERSION. OpenCode names an MCP tool
# ``<server>_<tool>`` with no namespace marker, so a server's deny pattern could
# also match a built-in id; these are re-allowed after the MCP rules. When
# bumping OpenCode in packages/sandbox-images/toolchain.json, re-run the wire
# contract test in test_opencode_reasoning_contract.py against the new binary
# (updating the version it asserts), then update this tuple and its version.
OPENCODE_BUILTIN_TOOL_IDS_VERSION = "1.18.29"
OPENCODE_BUILTIN_TOOL_IDS = (
    "apply_patch",
    "bash",
    "edit",
    "glob",
    "grep",
    "read",
    "skill",
    "task",
    "todowrite",
    "webfetch",
    "websearch",
    "write",
)


def mcp_name_segment(value: str) -> str:
    """One server or tool name, as both harnesses spell it inside a tool name."""
    # Both harnesses run JavaScript, whose regex replaces UTF-16 code units: a
    # character outside the Basic Multilingual Plane becomes two underscores.
    return _UNSAFE_NAME_CHARS.sub(lambda match: "_" * (2 if ord(match[0]) > 0xFFFF else 1), value)


def tool_allowlist(server: Mapping[str, Any]) -> tuple[str, ...] | None:
    """The server's allowlist; a malformed value allows no tools rather than all."""
    raw = server.get("toolAllowlist")
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        return ()
    return tuple(tool for tool in raw if isinstance(tool, str) and tool)


def _namespace_allowlists(servers: Iterable[Mapping[str, Any]]) -> Allowlists:
    """Each tool-name namespace's allowlist, keyed by sanitized server name.

    Servers whose names differ only in sanitized characters (``my.docs`` and
    ``my_docs``) produce the same tool names, so they share one entry. It is
    restricted if any of them is, to the tools every restricted one allows.
    """
    allowlists: Allowlists = {}
    for server in servers:
        if not server.get("name"):
            continue
        namespace = mcp_name_segment(str(server["name"]))
        allowlist = tool_allowlist(server)
        current = allowlists.get(namespace)
        if current is None:
            allowlists[namespace] = allowlist
        elif allowlist is not None:
            allowlists[namespace] = tuple(tool for tool in current if tool in allowlist)
    return allowlists


@dataclass(frozen=True)
class OpenCodeToolPolicy:
    """OpenCode ``permission`` rules for a session's MCP servers.

    ``rules`` is empty when no server is restricted. ``shadowed`` lists the
    unrestricted namespaces ``opencode_tool_policy`` leaves without an allow rule.
    """

    rules: dict[str, str] = field(default_factory=dict)
    shadowed: list[str] = field(default_factory=list)


def _set_last(rules: dict[str, str], key: str, action: str) -> None:
    # OpenCode applies the last matching rule, so a re-asserted key must move
    # to the end rather than keep its first position.
    rules.pop(key, None)
    rules[key] = action


def opencode_tool_policy(
    servers: Iterable[Mapping[str, Any]], other_tool_ids: Iterable[str]
) -> OpenCodeToolPolicy:
    """Rules that hide every MCP tool outside its server's allowlist.

    Denied tools are left out of the model request, not only refused when
    called. Rules follow the global allow, ordered so that a restricted
    namespace extending another (``foo_bar`` after ``foo``) keeps its own rules,
    and ``other_tool_ids`` (built-in and custom tools) caught by a deny pattern
    are re-allowed last.

    OpenCode names tools ``<server>_<tool>``, so an unrestricted ``docs_extra``'s
    ``docs_extra_*`` would also match restricted ``docs``' own ``extra_*``
    tools. Such a server gets no allow rule rather than widening the allowlist.
    """
    allowlists = _namespace_allowlists(servers)
    restricted = [namespace for namespace, allowlist in allowlists.items() if allowlist is not None]
    if not restricted:
        return OpenCodeToolPolicy()

    shadowed = sorted(
        namespace
        for namespace, allowlist in allowlists.items()
        if allowlist is None and any(namespace.startswith(f"{other}_") for other in restricted)
    )
    rules: dict[str, str] = {}
    for namespace in sorted(allowlists, key=len):
        allowlist = allowlists[namespace]
        if allowlist is None:
            if namespace not in shadowed:
                _set_last(rules, f"{namespace}_*", "allow")
            continue
        _set_last(rules, f"{namespace}_*", "deny")
        for tool in allowlist:
            _set_last(rules, f"{namespace}_{mcp_name_segment(tool)}", "allow")

    denied = [pattern for pattern, action in rules.items() if action == "deny"]
    for tool_id in other_tool_ids:
        if any(fnmatch.fnmatchcase(tool_id, pattern) for pattern in denied):
            _set_last(rules, tool_id, "allow")
    return OpenCodeToolPolicy(rules, shadowed)


@dataclass(frozen=True)
class ClaudeToolPolicy:
    """Claude Agent SDK options for a session's MCP servers; ``hooks`` is empty
    when no server is restricted."""

    allowed_tools: list[str]
    disallowed_tools: list[str]
    hooks: dict[HookEvent, list[HookMatcher]] = field(default_factory=dict)


def claude_tool_policy(
    servers: Iterable[Mapping[str, Any]], *, reserved: Collection[str] = ()
) -> ClaudeToolPolicy:
    """Allow and deny rules for each server's tools, plus a guard hook.

    ``reserved`` names servers the harness provides itself in place of any
    configured server of the same name: their configured allowlists are ignored
    and all their tools are allowed.

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
    allowlists = {
        namespace: allowlist
        for namespace, allowlist in _namespace_allowlists(servers).items()
        if namespace not in reserved
    }
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
    allowed.extend(f"mcp__{name}__*" for name in reserved)

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
