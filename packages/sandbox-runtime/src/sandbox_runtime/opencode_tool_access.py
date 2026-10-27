"""MCP tool allowlists rendered as OpenCode ``permission`` rules.

OpenCode names an MCP tool ``<server>_<tool>`` with no namespace marker, and an
MCP tool replaces a built-in or custom tool whose id it shares. A restricted
server's ``<server>_*`` deny therefore also hides any other tool whose id starts
that way: re-allowing that id would expose an unselected MCP tool that takes it.

A repository's agent config can re-allow denied tools, since OpenCode applies an
agent's rules after the global ones, so ``plugins/mcp-tool-guard.js`` refuses
calls the same rules deny.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .mcp_tool_access import mcp_name_segment, namespace_allowlists

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


@dataclass(frozen=True)
class OpenCodeToolPolicy:
    """OpenCode ``permission`` rules for a session's MCP servers.

    ``rules`` is empty when no server is restricted. ``shadowed`` lists the
    unrestricted namespaces left without an allow rule.
    """

    rules: dict[str, str] = field(default_factory=dict)
    shadowed: list[str] = field(default_factory=list)


def _set_last(rules: dict[str, str], key: str, action: str) -> None:
    # OpenCode applies the last matching rule, so a re-asserted key must move
    # to the end rather than keep its first position.
    rules.pop(key, None)
    rules[key] = action


def opencode_tool_policy(servers: Iterable[Mapping[str, Any]]) -> OpenCodeToolPolicy:
    """Rules that hide every MCP tool outside its server's allowlist.

    Denied tools are left out of the model request, not only refused when
    called. Rules follow the global allow, ordered so that a restricted
    namespace extending another (``foo_bar`` after ``foo``) keeps its own rules;
    a tool name both would claim must then be allowed by the longer one too.

    An unrestricted ``docs_extra``'s ``docs_extra_*`` would also match
    restricted ``docs``' own ``extra_*`` tools, so such a server gets no allow
    rule rather than widening the allowlist.
    """
    allowlists = namespace_allowlists(servers)
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
    return OpenCodeToolPolicy(rules, shadowed)
