"""Per-server MCP tool allowlists, rendered for each agent harness.

A server config's ``toolAllowlist`` names the server's own tools the agent may
use. Absent or ``None`` allows every tool; a list allows only those names, so
an empty list allows none.
"""

from __future__ import annotations

import fnmatch
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from claude_agent_sdk.types import HookCallback, HookContext, HookInput, SyncHookJSONOutput

    Allowlists = dict[str, tuple[str, ...] | None]

# OpenCode and Claude Code both build an MCP tool's name from the server and tool
# names with every character outside this set replaced by "_".
_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]")

# OpenCode's built-in tools (``GET /experimental/tool/ids``) at the version pinned
# in packages/sandbox-images/toolchain.json. OpenCode names an MCP tool
# ``<server>_<tool>`` with no namespace marker, so a server's deny rule can also
# match a built-in such as ``apply_patch``; these are re-allowed after the MCP
# rules. Re-run the wire contract test in test_opencode_reasoning_contract.py
# when bumping OpenCode.
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


def namespace_allowlists(servers: Iterable[Mapping[str, Any]]) -> Allowlists:
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


def opencode_shadowed_namespaces(allowlists: Allowlists) -> list[str]:
    """Unrestricted namespaces that extend a restricted one (``docs_extra`` next
    to ``docs``). OpenCode names tools ``<server>_<tool>``, so ``docs_extra_*``
    would also match ``docs``' own ``extra_*`` tools; these servers get none of
    their own tools rather than widen the restricted server's allowlist."""
    restricted = [namespace for namespace, allowlist in allowlists.items() if allowlist is not None]
    return sorted(
        namespace
        for namespace, allowlist in allowlists.items()
        if allowlist is None and any(namespace.startswith(f"{other}_") for other in restricted)
    )


def _set_last(rules: dict[str, str], key: str, action: str) -> None:
    # OpenCode applies the last matching rule, so a re-asserted key must move
    # to the end rather than keep its first position.
    rules.pop(key, None)
    rules[key] = action


def opencode_permission_rules(
    servers: Iterable[Mapping[str, Any]], other_tool_ids: Iterable[str]
) -> dict[str, str]:
    """OpenCode ``permission`` rules that hide every tool outside an allowlist.

    Denied tools are left out of the model request, not only refused when
    called. Rules follow the global allow, ordered so that a restricted
    namespace extending another (``foo_bar`` after ``foo``) keeps its own rules,
    and ``other_tool_ids`` (built-in and custom tools) caught by a deny
    pattern are re-allowed last. Returns no rules when nothing is restricted,
    leaving the global allow as the only rule.
    """
    allowlists = namespace_allowlists(servers)
    if all(allowlist is None for allowlist in allowlists.values()):
        return {}

    shadowed = set(opencode_shadowed_namespaces(allowlists))
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
    return rules


def claude_tool_rules(name: str, allowlist: tuple[str, ...] | None) -> tuple[list[str], list[str]]:
    """``(allowed_tools, disallowed_tools)`` entries for one Claude MCP server.

    Under ``dontAsk`` a listed tool runs and any other is refused, unless another
    approval covers it; ``claude_tool_guard`` refuses those. Claude Code removes
    a tool from context only when a deny rule names it, and the runtime does not
    know a server's other tool names, so they stay visible but are refused; an
    empty allowlist denies the whole server with a bare server rule.
    """
    prefix = f"mcp__{mcp_name_segment(name)}"
    if allowlist is None:
        return [f"{prefix}__*"], []
    if not allowlist:
        return [], [prefix]
    return [f"{prefix}__{mcp_name_segment(tool)}" for tool in allowlist], []


def claude_tool_guard(allowlists: Allowlists) -> HookCallback | None:
    """A ``PreToolUse`` hook refusing every unselected tool of a restricted server.

    Approvals add up across sources: a ``mcp__docs__*`` rule in the session's
    Claude settings, or the wildcard of a server whose name overlaps
    (``mcp__docs__*`` also matches ``docs__extra``'s tools, since Claude Code
    splits names on ``__``), would otherwise approve them. A hook's deny wins.
    """
    restricted = {ns: allowlist for ns, allowlist in allowlists.items() if allowlist is not None}
    if not restricted:
        return None
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
