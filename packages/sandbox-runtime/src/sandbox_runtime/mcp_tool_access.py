"""Per-server MCP tool allowlists: the model each harness renders its rules from.

A server config's ``toolAllowlist`` names the server's own tools the agent may
use. Absent or ``None`` allows every tool; a list allows only those names, so
an empty list allows none. OpenCode's rules live in ``opencode_tool_access``,
Claude Agent's in ``harness.claude_mcp_policy``, and Codex takes the allowlist
natively as ``enabled_tools``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

NamespaceAllowlists = dict[str, tuple[str, ...] | None]

# OpenCode and Claude Code both build an MCP tool's name from the server and tool
# names with every character outside this set replaced by "_".
_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]")


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


def namespace_allowlists(servers: Iterable[Mapping[str, Any]]) -> NamespaceAllowlists:
    """Each tool-name namespace's allowlist, keyed by sanitized server name.

    Servers whose names differ only in sanitized characters (``my.docs`` and
    ``my_docs``) produce the same tool names, so they share one entry. It is
    restricted if any of them is, to the tools every restricted one allows.
    """
    allowlists: NamespaceAllowlists = {}
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
