"""MCP tool allowlists rendered as OpenCode ``permission`` rules.

OpenCode names an MCP tool ``<server>_<tool>`` with no namespace marker, so the
deny pattern that hides a restricted server's other tools can also match a
built-in or custom tool id. Those ids are listed here and re-allowed after the
MCP rules.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .mcp_tool_access import mcp_name_segment, namespace_allowlists, tool_allowlist

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from pathlib import Path

# OpenCode's built-in tools (``GET /experimental/tool/ids``) at OpenCode
# OPENCODE_BUILTIN_TOOL_IDS_VERSION. When bumping OpenCode in
# packages/sandbox-images/toolchain.json, re-run the wire contract test in
# test_opencode_reasoning_contract.py against the new binary (updating the
# version it asserts), then update this tuple and its version.
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

_TOOL_EXPORT_SCAN_TIMEOUT_SECONDS = 15.0
# Lists each file's export names with Bun's parser, which reads a module without
# running it: OpenCode, a Bun program, loads the same syntax. A file the parser
# rejects maps to null.
_TOOL_EXPORT_SCAN_SCRIPT = """
const fs = require("fs");
const exports = {};
for (const file of process.argv.slice(1)) {
  try {
    const loader = file.endsWith(".ts") ? "ts" : "js";
    exports[file] = new Bun.Transpiler({ loader }).scan(fs.readFileSync(file, "utf8")).exports;
  } catch {
    exports[file] = null;
  }
}
console.log(JSON.stringify(exports));
"""


@dataclass(frozen=True)
class OpenCodeToolPolicy:
    """OpenCode ``permission`` rules for a session's MCP servers.

    ``rules`` is empty when no server is restricted. ``shadowed`` lists the
    unrestricted namespaces left without an allow rule.
    """

    rules: dict[str, str] = field(default_factory=dict)
    shadowed: list[str] = field(default_factory=list)


async def opencode_tool_rules(
    servers: Sequence[Mapping[str, Any]], tool_config_dirs: Sequence[Path], log: Any
) -> OpenCodeToolPolicy:
    """The session's rules, with the custom tools in ``tool_config_dirs`` re-allowed.

    The custom tools are scanned only when a server is restricted, since only a
    restricted server's deny pattern can hide one.
    """
    if all(tool_allowlist(server) is None for server in servers):
        return OpenCodeToolPolicy()
    custom_tool_ids = await _custom_tool_ids(tool_config_dirs, log)
    return opencode_tool_policy(servers, (*OPENCODE_BUILTIN_TOOL_IDS, *custom_tool_ids))


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

    denied = [pattern for pattern, action in rules.items() if action == "deny"]
    for tool_id in other_tool_ids:
        if any(fnmatch.fnmatchcase(tool_id, pattern) for pattern in denied):
            _set_last(rules, tool_id, "allow")
    return OpenCodeToolPolicy(rules, shadowed)


async def _custom_tool_ids(tool_config_dirs: Sequence[Path], log: Any) -> list[str]:
    """Ids of the custom tools in each config directory's ``tool`` and ``tools``.

    OpenCode names a file's default export ``<file>`` and each named export
    ``<file>_<export>``. The rules must be in its config before it loads the
    files, so their exports are read with Bun's parser. A file without ES module
    exports (CommonJS) or one the parser cannot read falls back to its file
    name, as if its only tool were the default export.
    """
    paths = [
        path
        for config_dir in tool_config_dirs
        for subdirectory in ("tool", "tools")
        for path in sorted((config_dir / subdirectory).glob("*"))
        if path.suffix in {".js", ".ts"} and path.is_file()
    ]
    if not paths:
        return []
    try:
        exports = await _read_tool_exports(paths)
    except Exception as exc:
        log.warn("opencode.custom_tool_scan_failed", exc=exc)
        exports = {}
    tool_ids: set[str] = set()
    for path in paths:
        names = exports.get(str(path))
        if not names:
            tool_ids.add(path.stem)
            continue
        tool_ids.update(path.stem if name == "default" else f"{path.stem}_{name}" for name in names)
    return sorted(tool_ids)


async def _read_tool_exports(paths: Sequence[Path]) -> dict[str, list[str] | None]:
    """Each tool file's export names, from the image's pinned ``bun``."""
    process = await asyncio.create_subprocess_exec(
        "bun",
        "-e",
        _TOOL_EXPORT_SCAN_SCRIPT,
        *map(str, paths),
        # Away from the repository, so its bunfig.toml does not apply.
        cwd="/",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), _TOOL_EXPORT_SCAN_TIMEOUT_SECONDS
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise RuntimeError(stderr.decode(errors="replace").strip()[-500:])
    exports: dict[str, list[str] | None] = json.loads(stdout)
    return exports
