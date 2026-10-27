"""Tests for the per-server MCP tool allowlist model the harnesses share."""

import pytest

from sandbox_runtime.mcp_tool_access import mcp_name_segment, namespace_allowlists, tool_allowlist


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
    def test_servers_sharing_tool_names_share_the_strictest_allowlist(self):
        servers = [server("my.docs", ["a", "b"]), server("my_docs"), server("my docs", ["b"])]
        assert namespace_allowlists(servers) == {"my_docs": ("b",)}

    def test_disjoint_allowlists_on_one_namespace_allow_no_tools(self):
        servers = [server("my.docs", ["a"]), server("my_docs", ["b"])]
        assert namespace_allowlists(servers) == {"my_docs": ()}

    def test_skips_servers_without_a_name(self):
        assert namespace_allowlists([{"toolAllowlist": ["a"]}]) == {}
