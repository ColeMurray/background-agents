"""Claude MCP policy and readiness, with process ownership left on the harness."""

import json
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime.harness.base import HarnessPrompt
from sandbox_runtime.harness.claude_mcp import (
    McpStatusClient,
    check_managed_mcp,
    mcp_server_options,
)
from tests.claude_fakes import FakeSdkClient, Harness, NativeMcpState, _result, _run

SERVER = {
    "name": "example",
    "type": "remote",
    "url": "https://proxy.example/mcp",
    "headers": {"Authorization": "Bearer sandbox"},
    "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
}


async def test_managed_reset_preserves_conversation_and_resets_cost_baseline(tmp_path):
    f = Harness(tmp_path, turns=[[_result(0.25)], [_result(0.40)]], mcp_servers=(SERVER,))
    await f.harness.open()
    await f.harness.create_session()
    await f.harness.prepare_managed_mcp({"example"})
    _, first = await _run(f.harness)
    old = f.client
    session_id = f.harness.session_id
    await f.harness.close_managed_mcp()
    assert old.disconnected
    await f.harness.prepare_managed_mcp({"example"})
    _, second = await _run(f.harness)
    assert f.client is not old
    assert f.client.options["resume"] == session_id
    assert first.message_cost_usd == 0.25
    assert second.message_cost_usd == 0.40
    await f.harness.close_managed_mcp()


async def test_unavailable_managed_names_cannot_fall_back_to_native_sources(tmp_path):
    f = Harness(tmp_path, mcp_servers=(SERVER,))
    await f.harness.open()
    await f.harness.create_session()
    unavailable = f.harness.build_options("claude-sonnet-4-6", None)
    assert "example" not in unavailable["mcp_servers"]
    assert json.loads(unavailable["settings"])["deniedMcpServers"] == [{"serverName": "example"}]
    assert unavailable["setting_sources"] == ["user", "project"]
    assert not unavailable.get("strict_mcp_config")
    await f.harness.prepare_managed_mcp({"example"})
    available = f.harness.build_options("claude-sonnet-4-6", None)
    assert available["mcp_servers"]["example"]["url"] == SERVER["url"]
    assert "deniedMcpServers" not in json.loads(available["settings"])
    await f.harness.close_managed_mcp()


async def test_turns_without_personal_mcp_keep_the_running_process(tmp_path):
    f = Harness(tmp_path, turns=[[_result(0.25)], [_result(0.40)]], mcp_servers=(SERVER,))
    await f.harness.open()
    await f.harness.create_session()
    await f.harness.prepare_managed_mcp(set())
    await _run(f.harness)
    old = f.client
    await f.harness.close_managed_mcp()
    assert not old.disconnected
    await f.harness.prepare_managed_mcp(set())
    await _run(f.harness)
    assert f.client is old
    await f.harness.close_managed_mcp()


async def test_connector_disabled_by_a_failed_turn_reconnects_in_the_next_process(tmp_path):
    f = Harness(tmp_path, turns=[[_result(0.25)], [_result(0.40)]], mcp_servers=(SERVER,))
    f.mcp.native = ("native",)
    f.mcp.disabled.add("native")
    f.mcp.failing.add("example")
    await f.harness.open()
    await f.harness.create_session()
    await f.harness.prepare_managed_mcp({"example"})
    events, outcome = await _run(f.harness)
    failed = f.client
    assert outcome.success
    assert [event["scope"] for event in events if event["type"] == "warning"] == ["mcp"]
    assert failed.mcp_toggles == [("example", False)]
    assert f.mcp.disabled == {"example", "native"}
    await f.harness.close_managed_mcp()

    f.mcp.failing.clear()
    await f.harness.prepare_managed_mcp({"example"})
    events, outcome = await _run(f.harness)
    assert f.client is not failed
    assert outcome.success
    assert not [event for event in events if event["type"] == "warning"]
    assert f.client.mcp_toggles == [("example", True)]
    status = await f.client.get_mcp_status()
    assert {server["name"]: server["status"] for server in status["mcpServers"]} == {
        "example": "connected",
        "native": "disabled",
    }
    await f.harness.close_managed_mcp()


def test_managed_config_preserves_headers_and_omits_unavailable_personal_servers():
    assert mcp_server_options((SERVER,), set()) == {}
    assert mcp_server_options((SERVER,), {"example"}) == {
        "example": {"type": "http", "url": SERVER["url"], "headers": SERVER["headers"]}
    }


@pytest.mark.parametrize(
    "command",
    [["npx", "--yes", "@fixture/mcp@1.2.3", "--stdio"], ["/opt/mcp/bin/server", "--stdio"]],
)
@pytest.mark.parametrize("allowed", [set(), {"example"}])
def test_personal_mcp_policy_preserves_local_package_command_and_environment(command, allowed):
    local = {"name": "local", "type": "local", "command": command, "env": {"TOKEN": "fixture"}}
    options = mcp_server_options((SERVER, local), allowed)
    assert options["local"] == {
        "type": "stdio",
        "command": command[0],
        "args": command[1:],
        "env": {"TOKEN": "fixture"},
    }
    assert ("example" in options) == bool(allowed)
    assert local["command"] == command


@pytest.mark.parametrize("status", ["connected", "failed"])
async def test_readiness_disables_and_warns_only_for_unavailable_servers(status):
    client = AsyncMock(spec=McpStatusClient)
    client.get_mcp_status.return_value = {"mcpServers": [{"name": "example", "status": status}]}
    emit = AsyncMock()
    await check_managed_mcp(client, {"example"}, HarnessPrompt("m", "test"), emit)
    if status == "connected":
        client.toggle_mcp_server.assert_not_awaited()
        emit.assert_not_awaited()
    else:
        client.toggle_mcp_server.assert_awaited_once_with("example", False)
        warning = emit.await_args.args[0]
        assert warning["messageId"] == "m"
        assert warning["scope"] == "mcp"


async def test_reenabling_a_server_that_still_cannot_connect_warns_and_disables_it_again():
    mcp = NativeMcpState(disabled={"example"}, failing={"example"})
    client = FakeSdkClient(options={"mcp_servers": {"example": {}}}, turns=[], mcp=mcp)
    emit = AsyncMock()
    await check_managed_mcp(client, {"example"}, HarnessPrompt("m", "test"), emit)
    assert client.mcp_toggles == [("example", True), ("example", False)]
    assert mcp.disabled == {"example"}
    assert emit.await_args.args[0]["scope"] == "mcp"


async def test_no_personal_servers_skips_native_status_requests():
    client = AsyncMock(spec=McpStatusClient)
    await check_managed_mcp(client, set(), HarnessPrompt("m", "test"), AsyncMock())
    client.get_mcp_status.assert_not_awaited()
