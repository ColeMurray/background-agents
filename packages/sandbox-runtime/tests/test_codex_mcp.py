"""Session MCP settings translate to native, server-scoped configuration."""

import json
from dataclasses import replace
from uuid import UUID

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.base import HarnessId, HarnessStartError
from sandbox_runtime.harness.codex.env import clean_codex_env, mcp_configuration
from tests.test_codex_lifecycle import build

SECRET = "synthetic-server-only-credential"


def _managed(name, auth_mode):
    return {
        "name": name,
        "type": "remote",
        "url": f"https://proxy.example/sessions/session/mcp/{name}",
        "headers": {"Authorization": "Bearer sandbox-fixture"},
        "managed_proxy": {"version": 1, "auth_mode": auth_mode, "auth_revision": 1},
    }


@pytest.mark.parametrize("auth_mode", ["none", "service_credentials"])
def test_managed_routing_keeps_nonpersonal_servers_but_excludes_personal(auth_mode):
    service = _managed("service", auth_mode)
    personal = _managed("personal", "user_oauth")
    local = {"name": "local", "type": "local", "command": ["/opt/mcp/bin/server", "--stdio"]}
    config = mcp_configuration((personal, service, local))
    assert set(config) == {"service", "local"}
    assert config["service"]["url"] == service["url"]
    assert config["service"]["http_headers"] == service["headers"]
    assert config["local"]["command"] == local["command"][0]
    assert config["local"]["args"] == ["--stdio"]
    assert personal["managed_proxy"]["auth_mode"] == "user_oauth"


async def test_codex_start_and_resume_exclude_personal_mcp_and_report_unsupported(tmp_path):
    harness, client = build(tmp_path)
    harness.config = replace(
        harness.config,
        mcp_servers=(
            _managed("personal", "user_oauth"),
            _managed("service", "service_credentials"),
        ),
    )

    def reply(method, params):
        if method in {"thread/start", "thread/resume"}:
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = reply
    try:
        await harness.create_session()
        assert await harness._resume_native("thread")
        configs = [
            call.args[1]["config"]["mcp_servers"]
            for call in client.request.call_args_list
            if call.args[0] in {"thread/start", "thread/resume"}
        ]
        assert len(configs) == 2
        assert all(set(config) == {"service"} for config in configs)
        bridge = AgentBridge(
            sandbox_id="sandbox",
            session_id="session",
            control_plane_url="https://fixture.invalid",
            auth_token="fixture",
            harness=harness,
            harness_id=HarnessId.CODEX,
        )
        bridge.repo_manifest_path = tmp_path / "repositories.json"
        first = bridge._build_ready_event()
        assert first["harness"] == "codex"
        assert first["managedMcpVersion"] == 0
        assert UUID(first["bridgeInstanceId"]).version == 4
        assert bridge._build_ready_event()["bridgeInstanceId"] == first["bridgeInstanceId"]
    finally:
        await harness.close()


@pytest.mark.parametrize("field", ["env", "environment"])
def test_local_mcp_environment(field):
    server = {"name": "fixture", "command": ["fixture", "--stdio"], field: {"TOKEN": SECRET}}
    config = mcp_configuration((server,))["fixture"]
    assert config["command"] == "fixture"
    assert config["args"] == ["--stdio"]
    assert config["env"] == {"TOKEN": SECRET}
    assert "http_headers" not in config
    assert server[field] == {"TOKEN": SECRET}


@pytest.mark.parametrize("field", ["headers", "env"])
def test_remote_mcp_headers(field):
    server = {
        "name": "linear",
        "type": "remote",
        "url": "https://mcp.example/mcp",
        field: {"Authorization": SECRET},
    }
    config = mcp_configuration((server,))["linear"]
    assert config["url"] == server["url"]
    assert config["http_headers"] == {"Authorization": SECRET}
    assert "env" not in config


def test_remote_empty_headers_fall_back_to_legacy_env():
    config = mcp_configuration(
        (
            {
                "name": "linear",
                "url": "https://mcp.example/mcp",
                "headers": {},
                "env": {"Authorization": SECRET},
            },
        )
    )
    assert config["linear"]["http_headers"] == {"Authorization": SECRET}


@pytest.mark.parametrize("field", ["environment", "env", "headers"])
@pytest.mark.parametrize("values", [[SECRET], {"TOKEN": 123}, {123: SECRET}])
def test_invalid_mcp_settings_do_not_disclose_values(field, values):
    with pytest.raises(HarnessStartError, match="Invalid MCP") as error:
        mcp_configuration(({"url": "https://mcp.example", field: values},))
    assert SECRET not in str(error.value)


def test_disabled_mcp_settings_are_not_forwarded():
    assert (
        mcp_configuration(
            (
                {
                    "name": "disabled",
                    "enabled": False,
                    "headers": {"Authorization": SECRET},
                },
            )
        )
        == {}
    )


def test_native_env_preserves_session_config_and_omits_legacy_header_variables(tmp_path):
    parent = {
        "SESSION_CONFIG": json.dumps({"mcp_servers": [{"headers": {"X-Key": SECRET}}]}),
        "OI_MCP_0_HEADER_0": SECRET,
        "USER_BUILD_VAR": "retained",
    }
    env = clean_codex_env(parent, tmp_path)
    assert env["SESSION_CONFIG"] == parent["SESSION_CONFIG"]
    assert "OI_MCP_0_HEADER_0" not in env
    assert env["USER_BUILD_VAR"] == "retained"
    assert parent["OI_MCP_0_HEADER_0"] == SECRET


@pytest.mark.parametrize("url", ["", "   "])
def test_remote_mcp_requires_a_non_empty_url(url):
    with pytest.raises(HarnessStartError, match="requires a URL"):
        mcp_configuration(({"name": "remote", "url": url},))
