"""Tests for MCP tool allowlists rendered as Claude Agent SDK options."""

import pytest

from sandbox_runtime.harness.claude_mcp_policy import claude_tool_policy


def server(name, allowlist=None, **extra):
    config = {"name": name, "type": "remote", "url": "https://mcp.example.com", **extra}
    if allowlist is not None:
        config["toolAllowlist"] = allowlist
    return config


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

    @pytest.mark.parametrize(
        ("tool_name", "expected"),
        [
            # docs' extra__search, and docs__extra's unselected search.
            ("mcp__docs__extra__search", "deny"),
            ("mcp__docs__extra__query", "deny"),
            ("mcp__docs__other", "deny"),
        ],
    )
    async def test_guard_needs_every_overlapping_restricted_server_to_allow_a_name(
        self, tool_name, expected
    ):
        policy = claude_tool_policy(
            [server("docs", ["extra__search"]), server("docs__extra", ["query"])]
        )
        assert await self.decision(policy, tool_name) == expected
