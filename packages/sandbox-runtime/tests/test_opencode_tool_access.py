"""Tests for MCP tool allowlists rendered as OpenCode permission rules."""

import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.opencode_tool_access import (
    OPENCODE_BUILTIN_TOOL_IDS,
    OPENCODE_BUILTIN_TOOL_IDS_VERSION,
    _custom_tool_ids,
    opencode_tool_policy,
    opencode_tool_rules,
)

TOOLCHAIN = Path(__file__).parents[2] / "sandbox-images/toolchain.json"


def server(name, allowlist=None, **extra):
    config = {"name": name, "type": "remote", "url": "https://mcp.example.com", **extra}
    if allowlist is not None:
        config["toolAllowlist"] = allowlist
    return config


def config_dirs(root):
    return (root / ".opencode", root / "global")


class TestOpencodeToolPolicy:
    def test_no_rules_when_nothing_is_restricted(self):
        policy = opencode_tool_policy([server("docs"), server("linear")], ["memory_read"])
        assert policy.rules == {}
        assert policy.shadowed == []

    def test_colliding_names_keep_only_tools_every_restricted_server_allows(self):
        # my.docs and my_docs produce the same tool names, so neither may widen the other.
        servers = [server("my.docs", ["search", "fetch"]), server("my_docs", ["fetch"])]
        assert opencode_tool_policy(servers, []).rules == {
            "my_docs_*": "deny",
            "my_docs_fetch": "allow",
        }

    def test_a_restricted_server_restricts_a_colliding_unrestricted_one(self):
        servers = [server("my.docs"), server("my_docs", ["search"])]
        expected = {"my_docs_*": "deny", "my_docs_search": "allow"}
        assert opencode_tool_policy(servers, []).rules == expected
        assert opencode_tool_policy(list(reversed(servers)), []).rules == expected

    def test_denies_the_server_namespace_then_allows_listed_tools(self):
        rules = opencode_tool_policy([server("docs", ["search", "fetch"])], []).rules
        assert list(rules.items()) == [
            ("docs_*", "deny"),
            ("docs_search", "allow"),
            ("docs_fetch", "allow"),
        ]

    def test_empty_allowlist_denies_the_whole_server(self):
        assert opencode_tool_policy([server("docs", [])], []).rules == {"docs_*": "deny"}

    def test_sanitizes_server_and_tool_names(self):
        rules = opencode_tool_policy([server("my.server", ["find/issues"])], []).rules
        assert list(rules) == ["my_server_*", "my_server_find_issues"]

    def test_unrestricted_namespace_extending_a_restricted_one_gets_no_tools(self):
        # OpenCode names tools <server>_<tool>, so foo_bar's "foo_bar_*" would also
        # allow foo's own bar_* tools; it is left under foo's deny instead.
        policy = opencode_tool_policy([server("foo_bar"), server("foo", ["query"])], [])
        assert list(policy.rules.items()) == [("foo_*", "deny"), ("foo_query", "allow")]
        assert policy.shadowed == ["foo_bar"]

    def test_restricted_longer_namespace_keeps_its_rules_after_a_shorter_restricted_one(self):
        rules = opencode_tool_policy([server("foo_bar", ["x"]), server("foo", ["query"])], []).rules
        assert list(rules.items()) == [
            ("foo_*", "deny"),
            ("foo_query", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_namespaces_that_only_share_a_prefix_are_not_shadowed(self):
        policy = opencode_tool_policy([server("foobar"), server("foo", ["query"])], [])
        assert policy.shadowed == []
        assert policy.rules["foobar_*"] == "allow"

    def test_restricted_longer_namespace_overrides_unrestricted_shorter_one(self):
        rules = opencode_tool_policy([server("foo"), server("foo_bar", ["x"])], []).rules
        assert list(rules.items()) == [
            ("foo_*", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_reallows_other_tools_a_deny_pattern_would_hide(self):
        rules = opencode_tool_policy(
            [server("memory", ["recall"]), server("apply", [])],
            ["memory_read", "memory_search", "apply_patch", "bash", "spawn-child"],
        ).rules
        assert list(rules.items()) == [
            ("apply_*", "deny"),
            ("memory_*", "deny"),
            ("memory_recall", "allow"),
            ("memory_read", "allow"),
            ("memory_search", "allow"),
            ("apply_patch", "allow"),
        ]

    def test_skips_servers_without_a_name(self):
        assert opencode_tool_policy([{"toolAllowlist": []}], []).rules == {}

    def test_builtin_tool_ids_are_unique_and_sorted(self):
        assert list(OPENCODE_BUILTIN_TOOL_IDS) == sorted(set(OPENCODE_BUILTIN_TOOL_IDS))

    def test_builtin_tool_ids_were_taken_from_the_pinned_opencode(self):
        # After bumping OpenCode, re-run the MCP wire test in
        # test_opencode_reasoning_contract.py against the new binary, then
        # update OPENCODE_BUILTIN_TOOL_IDS and its version.
        pinned = json.loads(TOOLCHAIN.read_text())["opencode"]
        assert pinned == OPENCODE_BUILTIN_TOOL_IDS_VERSION


class TestOpencodeToolRules:
    @pytest.mark.asyncio
    async def test_does_not_scan_custom_tools_without_a_restricted_server(self, tmp_path):
        (tmp_path / ".opencode" / "tool").mkdir(parents=True)
        (tmp_path / ".opencode" / "tool" / "docs_local.js").write_text("export default 1")
        with patch("sandbox_runtime.opencode_tool_access._read_tool_exports") as read_tool_exports:
            policy = await opencode_tool_rules([server("docs")], config_dirs(tmp_path), MagicMock())
        read_tool_exports.assert_not_called()
        assert policy.rules == {}

    @pytest.mark.asyncio
    async def test_reallows_built_in_and_custom_tools_a_deny_pattern_would_hide(self, tmp_path):
        global_tools = tmp_path / "global" / "tools"
        global_tools.mkdir(parents=True)
        (global_tools / "read_notes.js").write_text("export default tool({})")
        scanned = AsyncMock(return_value={str(global_tools / "read_notes.js"): ["default"]})
        with patch("sandbox_runtime.opencode_tool_access._read_tool_exports", scanned):
            policy = await opencode_tool_rules(
                [server("read", ["page"])], config_dirs(tmp_path), MagicMock()
            )
        assert list(policy.rules.items()) == [
            ("read_*", "deny"),
            ("read_page", "allow"),
            ("read_notes", "allow"),
        ]


class TestCustomToolIds:
    @pytest.fixture
    def tool_dir(self, tmp_path):
        tool_dir = tmp_path / ".opencode" / "tool"
        tool_dir.mkdir(parents=True)
        return tool_dir

    @pytest.mark.asyncio
    @pytest.mark.skipif(shutil.which("bun") is None, reason="needs bun, as in the sandbox image")
    async def test_names_tools_as_opencode_does_from_bun_parsed_exports(self, tmp_path, tool_dir):
        sources = {
            # A comment or string that looks like an export is not one.
            "docs.ts": '/* export const fetch_page = 1 */ const s = "export const x = 1";\n'
            "export const local_index = tool({}), lookup = tool({});",
            "docs_local.js": 'import { tool } from "@opencode-ai/plugin"; export default tool({});',
            "docs_notes.js": "const a = tool({}); export { a, a as find };",
            "broken.js": "export const = ;",
            "legacy.js": 'const { tool } = require("@opencode-ai/plugin"); module.exports = tool({});',
            "readme.md": "export default 1",
        }
        for name, source in sources.items():
            (tool_dir / name).write_text(source)
        (tool_dir / "folder.ts").mkdir()
        (tool_dir / "gone.js").symlink_to(tmp_path / "missing.js")
        log = MagicMock()

        assert await _custom_tool_ids(config_dirs(tmp_path), log) == [
            # A file Bun cannot parse, or a CommonJS one, falls back to its name.
            "broken",
            "docs_local",
            "docs_local_index",
            "docs_lookup",
            "docs_notes_a",
            "docs_notes_find",
            "legacy",
        ]
        log.warn.assert_not_called()

    @pytest.mark.asyncio
    async def test_falls_back_to_file_names_when_the_scan_fails(self, tmp_path, tool_dir):
        (tool_dir / "docs_notes.js").write_text("export const lookup = tool({})")
        log = MagicMock()
        failing = AsyncMock(side_effect=FileNotFoundError("bun"))

        with patch("sandbox_runtime.opencode_tool_access._read_tool_exports", failing):
            assert await _custom_tool_ids(config_dirs(tmp_path), log) == ["docs_notes"]
        log.warn.assert_called_once()
        assert log.warn.call_args.args[0] == "opencode.custom_tool_scan_failed"
