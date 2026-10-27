"""Tests for the SessionConfig built from a create-sandbox request."""

from src import web_api


def test_session_config_helper_keeps_mcp_tool_allowlists():
    """Rebuilding SessionConfig must not drop a server's tool allowlist."""
    servers = [
        {"id": "a", "name": "docs", "type": "remote", "url": "https://mcp.docs"},
        {
            "id": "b",
            "name": "linear",
            "type": "remote",
            "url": "https://mcp.linear",
            "toolAllowlist": ["list_issues"],
        },
        {"id": "c", "name": "noisy", "type": "local", "command": ["npx"], "toolAllowlist": []},
    ]
    config = web_api._session_config_from_create_request(
        {"session_id": "s1", "mcp_servers": servers},
        repo_owner="acme",
        repo_name="app",
    )

    dumped = config.model_dump(mode="json")["mcp_servers"]
    assert [server.get("toolAllowlist") for server in dumped] == [None, ["list_issues"], []]
