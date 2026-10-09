"""Tests for per-server MCP tool allowlists in both harnesses."""

import pytest

from sandbox_runtime.mcp_tool_access import (
    OPENCODE_BUILTIN_TOOL_IDS,
    claude_tool_guard,
    claude_tool_rules,
    mcp_name_segment,
    namespace_allowlists,
    opencode_permission_rules,
    opencode_shadowed_namespaces,
    tool_allowlist,
)


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


class TestNamespaceAllowlists:
    def test_keys_allowlists_by_sanitized_server_name(self):
        assert namespace_allowlists([server("my.docs", ["search"]), server("linear")]) == {
            "my_docs": ("search",),
            "linear": None,
        }

    def test_colliding_names_keep_only_tools_every_restricted_server_allows(self):
        # my.docs and my_docs produce the same tool names, so neither may widen the other.
        servers = [server("my.docs", ["search", "fetch"]), server("my_docs", ["fetch"])]
        assert namespace_allowlists(servers) == {"my_docs": ("fetch",)}

    def test_a_restricted_server_restricts_a_colliding_unrestricted_one(self):
        servers = [server("my.docs"), server("my_docs", ["search"])]
        assert namespace_allowlists(servers) == {"my_docs": ("search",)}
        assert namespace_allowlists(list(reversed(servers))) == {"my_docs": ("search",)}

    def test_skips_servers_without_a_name(self):
        assert namespace_allowlists([{"toolAllowlist": []}]) == {}


class TestOpencodePermissionRules:
    def test_no_rules_when_nothing_is_restricted(self):
        assert opencode_permission_rules([server("docs"), server("linear")], ["memory_read"]) == {}

    def test_denies_the_server_namespace_then_allows_listed_tools(self):
        rules = opencode_permission_rules([server("docs", ["search", "fetch"])], [])
        assert list(rules.items()) == [
            ("docs_*", "deny"),
            ("docs_search", "allow"),
            ("docs_fetch", "allow"),
        ]

    def test_empty_allowlist_denies_the_whole_server(self):
        assert opencode_permission_rules([server("docs", [])], []) == {"docs_*": "deny"}

    def test_sanitizes_server_and_tool_names(self):
        rules = opencode_permission_rules([server("my.server", ["find/issues"])], [])
        assert list(rules) == ["my_server_*", "my_server_find_issues"]

    def test_unrestricted_namespace_extending_a_restricted_one_gets_no_tools(self):
        # OpenCode names tools <server>_<tool>, so foo_bar's "foo_bar_*" would also
        # allow foo's own bar_* tools; it is left under foo's deny instead.
        servers = [server("foo_bar"), server("foo", ["query"])]
        rules = opencode_permission_rules(servers, [])
        assert list(rules.items()) == [("foo_*", "deny"), ("foo_query", "allow")]
        assert opencode_shadowed_namespaces(namespace_allowlists(servers)) == ["foo_bar"]

    def test_restricted_longer_namespace_keeps_its_rules_after_a_shorter_restricted_one(self):
        rules = opencode_permission_rules([server("foo_bar", ["x"]), server("foo", ["query"])], [])
        assert list(rules.items()) == [
            ("foo_*", "deny"),
            ("foo_query", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_namespaces_that_only_share_a_prefix_are_not_shadowed(self):
        servers = [server("foobar"), server("foo", ["query"])]
        assert opencode_shadowed_namespaces(namespace_allowlists(servers)) == []
        assert opencode_permission_rules(servers, [])["foobar_*"] == "allow"

    def test_restricted_longer_namespace_overrides_unrestricted_shorter_one(self):
        rules = opencode_permission_rules([server("foo"), server("foo_bar", ["x"])], [])
        assert list(rules.items()) == [
            ("foo_*", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_reallows_other_tools_a_deny_pattern_would_hide(self):
        rules = opencode_permission_rules(
            [server("memory", ["recall"]), server("apply", [])],
            ["memory_read", "memory_search", "apply_patch", "bash", "spawn-child"],
        )
        assert list(rules.items()) == [
            ("apply_*", "deny"),
            ("memory_*", "deny"),
            ("memory_recall", "allow"),
            ("memory_read", "allow"),
            ("memory_search", "allow"),
            ("apply_patch", "allow"),
        ]

    def test_skips_servers_without_a_name(self):
        assert opencode_permission_rules([{"toolAllowlist": []}], []) == {}

    def test_builtin_tool_ids_are_unique_and_sorted(self):
        assert list(OPENCODE_BUILTIN_TOOL_IDS) == sorted(set(OPENCODE_BUILTIN_TOOL_IDS))


class TestClaudeToolRules:
    def test_unrestricted_server_allows_every_tool(self):
        assert claude_tool_rules("linear", None) == (["mcp__linear__*"], [])

    def test_restricted_server_allows_only_listed_tools(self):
        assert claude_tool_rules("linear", ("list_issues", "get/issue")) == (
            ["mcp__linear__list_issues", "mcp__linear__get_issue"],
            [],
        )

    def test_empty_allowlist_denies_the_whole_server(self):
        assert claude_tool_rules("linear", ()) == ([], ["mcp__linear"])

    def test_sanitizes_the_server_name(self):
        assert claude_tool_rules("my server", None) == (["mcp__my_server__*"], [])


class TestClaudeToolGuard:
    @staticmethod
    async def decision(guard, tool_name):
        result = await guard({"tool_name": tool_name}, None, None)
        return result.get("hookSpecificOutput", {}).get("permissionDecision", "pass")

    def test_no_guard_when_nothing_is_restricted(self):
        assert claude_tool_guard({"linear": None}) is None

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
    async def test_refuses_only_restricted_servers_unselected_tools(self, tool_name, expected):
        guard = claude_tool_guard({"linear": ("get/issue",), "docs": None, "noisy": ()})
        assert guard is not None
        assert await self.decision(guard, tool_name) == expected

    @pytest.mark.parametrize(
        ("tool_name", "expected"),
        [
            # Claude Code splits names on "__", so docs' approval covers these too.
            ("mcp__docs__extra__search", "pass"),
            ("mcp__docs__extra__delete", "deny"),
            ("mcp__docs__fetch_page", "pass"),
        ],
    )
    async def test_refuses_unselected_tools_an_overlapping_server_would_approve(
        self, tool_name, expected
    ):
        allowlists = namespace_allowlists([server("docs"), server("docs__extra", ["search"])])
        guard = claude_tool_guard(allowlists)
        assert guard is not None
        assert await self.decision(guard, tool_name) == expected
