"""Session MCP settings translate to native, server-scoped configuration."""

import json

import pytest

from sandbox_runtime.harness.base import HarnessStartError
from sandbox_runtime.harness.codex.env import clean_codex_env, mcp_configuration

SECRET = "synthetic-server-only-credential"


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
