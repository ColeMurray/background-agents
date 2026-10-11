"""Tests for per-server MCP tool allowlists in both harnesses."""

import json
from pathlib import Path

import pytest

from sandbox_runtime.mcp_tool_access import (
    OPENCODE_BUILTIN_TOOL_IDS,
    OPENCODE_BUILTIN_TOOL_IDS_VERSION,
    claude_tool_policy,
    mcp_name_segment,
    opencode_tool_policy,
    tool_allowlist,
)

TOOLCHAIN = Path(__file__).parents[2] / "sandbox-images/toolchain.json"


def server(name, allowlist=None, **extra):
    config = {"name": name, "type": "remote", "url": "https://mcp.example.com", **extra}
    if allowlist is not None:
        config["toolAllowlist"] = allowlist
    return config


class TestToolAllowlist:
    def test_absent_or_null_allows_every_tool(self):
        assert tool_allowlist(server("docs")) is None
        assert tool_allowlist({**server("docs"), "toolAllowlist": None}) is None

    def test_keeps_named_tools(self):
        assert tool_allowlist(server("docs", ["search", "fetch"])) == ("search", "fetch")

    @pytest.mark.parametrize("raw", ["search", {"tools": ["search"]}, 1])
    def test_malformed_value_allows_no_tools(self, raw):
        assert tool_allowlist({**server("docs"), "toolAllowlist": raw}) == ()

    def test_drops_non_string_and_blank_entries(self):
        assert tool_allowlist(server("docs", ["search", "", 3, None])) == ("search",)


class TestMcpNameSegment:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("linear", "linear"),
            ("my.server", "my_server"),
            ("find/issues", "find_issues"),
            ("café", "caf_"),
            # One underscore per UTF-16 code unit, as JavaScript's regex replaces them.
            ("my\U0001f600docs", "my__docs"),
        ],
    )
    def test_matches_harness_tool_name_sanitization(self, raw, expected):
        assert mcp_name_segment(raw) == expected


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


class TestClaudeToolPolicy:
    @staticmethod
    async def decision(policy, tool_name):
        [matcher] = policy.hooks["PreToolUse"]
        [guard] = matcher.hooks
        result = await guard({"tool_name": tool_name}, None, None)
        return result.get("hookSpecificOutput", {}).get("permissionDecision", "pass")

    def test_unrestricted_server_allows_every_tool_without_a_guard(self):
        policy = claude_tool_policy([server("linear")])
        assert policy.allowed_tools == ["mcp__linear__*"]
        assert policy.disallowed_tools == []
        assert policy.hooks == {}

    def test_restricted_server_allows_only_listed_tools(self):
        policy = claude_tool_policy([server("linear", ["list_issues", "get/issue"])])
        assert policy.allowed_tools == ["mcp__linear__list_issues", "mcp__linear__get_issue"]
        assert policy.disallowed_tools == []

    def test_empty_allowlist_denies_the_whole_server(self):
        policy = claude_tool_policy([server("linear", [])])
        assert policy.allowed_tools == []
        assert policy.disallowed_tools == ["mcp__linear"]

    def test_sanitizes_the_server_name(self):
        assert claude_tool_policy([server("my server")]).allowed_tools == ["mcp__my_server__*"]

    def test_servers_sharing_tool_names_share_the_strictest_allowlist(self):
        policy = claude_tool_policy([server("my.docs"), server("my_docs", ["search"])])
        assert policy.allowed_tools == ["mcp__my_docs__search"]

    def test_reserved_server_replaces_a_configured_one(self):
        policy = claude_tool_policy([server("oi", ["search"]), server("linear")], reserved=("oi",))
        assert policy.allowed_tools == ["mcp__linear__*", "mcp__oi__*"]
        assert policy.hooks == {}

    @pytest.mark.parametrize(
        ("tool_name", "expected"),
        [
            ("mcp__linear__get_issue", "pass"),
            ("mcp__linear__delete_issue", "deny"),
            ("mcp__docs__anything", "pass"),
            ("mcp__noisy__shout", "deny"),
            ("Bash", "pass"),
        ],
    )
    async def test_guard_refuses_only_restricted_servers_unselected_tools(
        self, tool_name, expected
    ):
        policy = claude_tool_policy(
            [server("linear", ["get/issue"]), server("docs"), server("noisy", [])]
        )
        assert await self.decision(policy, tool_name) == expected

    @pytest.mark.parametrize(
        ("tool_name", "expected"),
        [
            # Claude Code splits names on "__", so docs' approval covers these too.
            ("mcp__docs__extra__search", "pass"),
            ("mcp__docs__extra__delete", "deny"),
            ("mcp__docs__fetch_page", "pass"),
        ],
    )
    async def test_guard_refuses_unselected_tools_an_overlapping_server_would_approve(
        self, tool_name, expected
    ):
        policy = claude_tool_policy([server("docs"), server("docs__extra", ["search"])])
        assert await self.decision(policy, tool_name) == expected
