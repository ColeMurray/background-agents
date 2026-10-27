"""Tests for MCP tool allowlists rendered as OpenCode permission rules."""

from sandbox_runtime.opencode_tool_access import opencode_tool_policy


def server(name, allowlist=None, **extra):
    config = {"name": name, "type": "remote", "url": "https://mcp.example.com", **extra}
    if allowlist is not None:
        config["toolAllowlist"] = allowlist
    return config


class TestOpencodeToolPolicy:
    def test_no_rules_when_nothing_is_restricted(self):
        policy = opencode_tool_policy([server("docs"), server("linear")])
        assert policy.rules == {}
        assert policy.shadowed == []

    def test_colliding_names_keep_only_tools_every_restricted_server_allows(self):
        # my.docs and my_docs produce the same tool names, so neither may widen the other.
        servers = [server("my.docs", ["search", "fetch"]), server("my_docs", ["fetch"])]
        assert opencode_tool_policy(servers).rules == {
            "my_docs_*": "deny",
            "my_docs_fetch": "allow",
        }

    def test_a_restricted_server_restricts_a_colliding_unrestricted_one(self):
        servers = [server("my.docs"), server("my_docs", ["search"])]
        expected = {"my_docs_*": "deny", "my_docs_search": "allow"}
        assert opencode_tool_policy(servers).rules == expected
        assert opencode_tool_policy(list(reversed(servers))).rules == expected

    def test_denies_the_server_namespace_then_allows_listed_tools(self):
        rules = opencode_tool_policy([server("docs", ["search", "fetch"])]).rules
        assert list(rules.items()) == [
            ("docs_*", "deny"),
            ("docs_search", "allow"),
            ("docs_fetch", "allow"),
        ]

    def test_empty_allowlist_denies_the_whole_server(self):
        assert opencode_tool_policy([server("docs", [])]).rules == {"docs_*": "deny"}

    def test_sanitizes_server_and_tool_names(self):
        rules = opencode_tool_policy([server("my.server", ["find/issues"])]).rules
        assert list(rules) == ["my_server_*", "my_server_find_issues"]

    def test_unrestricted_namespace_extending_a_restricted_one_gets_no_tools(self):
        # OpenCode names tools <server>_<tool>, so foo_bar's "foo_bar_*" would also
        # allow foo's own bar_* tools; it is left under foo's deny instead.
        policy = opencode_tool_policy([server("foo_bar"), server("foo", ["query"])])
        assert list(policy.rules.items()) == [("foo_*", "deny"), ("foo_query", "allow")]
        assert policy.shadowed == ["foo_bar"]

    def test_restricted_longer_namespace_keeps_its_rules_after_a_shorter_restricted_one(self):
        rules = opencode_tool_policy([server("foo_bar", ["x"]), server("foo", ["query"])]).rules
        assert list(rules.items()) == [
            ("foo_*", "deny"),
            ("foo_query", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_namespaces_that_only_share_a_prefix_are_not_shadowed(self):
        policy = opencode_tool_policy([server("foobar"), server("foo", ["query"])])
        assert policy.shadowed == []
        assert policy.rules["foobar_*"] == "allow"

    def test_restricted_longer_namespace_overrides_unrestricted_shorter_one(self):
        rules = opencode_tool_policy([server("foo"), server("foo_bar", ["x"])]).rules
        assert list(rules.items()) == [
            ("foo_*", "allow"),
            ("foo_bar_*", "deny"),
            ("foo_bar_x", "allow"),
        ]

    def test_skips_servers_without_a_name(self):
        assert opencode_tool_policy([{"toolAllowlist": []}]).rules == {}

    def test_does_not_reallow_other_tools_a_deny_pattern_hides(self):
        # OpenCode lets an MCP tool take a built-in or custom tool's id, so
        # re-allowing apply_patch would expose an unselected "patch" tool of apply.
        rules = opencode_tool_policy([server("apply", ["safe"])]).rules
        assert list(rules.items()) == [("apply_*", "deny"), ("apply_safe", "allow")]

    def test_a_name_two_restricted_servers_claim_needs_both_to_allow_it(self):
        # docs_extra_search is docs' extra_search and docs_extra's search.
        rules = opencode_tool_policy(
            [server("docs", ["extra_search"]), server("docs_extra", ["query"])]
        ).rules
        assert list(rules.items()) == [
            ("docs_*", "deny"),
            ("docs_extra_search", "allow"),
            ("docs_extra_*", "deny"),
            ("docs_extra_query", "allow"),
        ]
