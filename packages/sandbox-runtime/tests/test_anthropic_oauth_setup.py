"""Tests for managed Anthropic OAuth setup and plugin deployment."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call, patch

from sandbox_runtime.opencode_server import OpenCodeServer
from tests.runtime_helpers import make_opencode_server


def _make_opencode_server() -> OpenCodeServer:
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return make_opencode_server()


def test_auth_json_merges_anthropic_sentinel_with_existing_entries(tmp_path):
    supervisor = _make_opencode_server()
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(json.dumps({"xai": {"type": "api", "key": "existing"}}))

    with (
        patch.dict("os.environ", {"ANTHROPIC_OAUTH_MANAGED": "1"}, clear=True),
        patch("pathlib.Path.home", return_value=tmp_path),
    ):
        supervisor._setup_managed_oauth()

    assert json.loads(auth_file.read_text()) == {
        "xai": {"type": "api", "key": "existing"},
        "anthropic": {
            "type": "oauth",
            "refresh": "managed-by-control-plane",
            "access": "",
            "expires": 0,
        },
    }


def test_anthropic_plugin_uses_broker_without_local_refresh_credentials():
    plugin = (
        Path(__file__).parents[1]
        / "src"
        / "sandbox_runtime"
        / "plugins"
        / "anthropic-auth-plugin.js"
    ).read_text()

    assert 'provider: "anthropic"' in plugin
    assert 'providerLabel: "Anthropic"' in plugin
    assert "/anthropic-token-refresh" not in plugin
    assert "ANTHROPIC_OAUTH_REFRESH_TOKEN" not in plugin
    assert "setAuth" not in plugin
    assert "rewriteRequestBody" in plugin
    assert "rewriteResponse" in plugin
    assert "methods: []" in plugin


async def test_start_opencode_deploys_anthropic_plugin_and_broker_once(tmp_path):
    supervisor = _make_opencode_server()
    supervisor.workspace_path = tmp_path / "workspace"
    supervisor.workspace_path.mkdir()
    (supervisor.workspace_path / ".git").mkdir()
    supervisor.repo_path = supervisor.workspace_path / "app"
    plugin_dir = tmp_path / "app" / "sandbox_runtime" / "plugins"
    plugin_dir.mkdir(parents=True)
    xai_source = plugin_dir / "xai-auth-plugin.js"
    xai_source.write_text("export const XaiAuthProxy = async () => ({});")
    anthropic_source = plugin_dir / "anthropic-auth-plugin.js"
    anthropic_source.write_text("export const AnthropicAuthProxy = async () => ({});")
    broker_source = plugin_dir / "provider-token-broker.js"
    broker_source.write_text("export function createProviderTokenBroker() {}")
    fake_proc = MagicMock(stdout=None)
    original_path = Path

    with (
        patch.dict(
            "os.environ",
            {"XAI_OAUTH_MANAGED": "1", "ANTHROPIC_OAUTH_MANAGED": "1"},
            clear=True,
        ),
        patch("sandbox_runtime.opencode_server.Path") as mock_path,
        patch("sandbox_runtime.opencode_server.shutil.copy") as mock_copy,
        patch("sandbox_runtime.opencode_server.install_runtime_git_excludes") as mock_excludes,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            AsyncMock(return_value=fake_proc),
        ),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        mock_path.side_effect = lambda value: {
            "/app/sandbox_runtime/plugins/xai-auth-plugin.js": xai_source,
            "/app/sandbox_runtime/plugins/anthropic-auth-plugin.js": anthropic_source,
            "/app/sandbox_runtime/plugins/provider-token-broker.js": broker_source,
        }.get(value, original_path(value))
        supervisor._setup_managed_oauth = MagicMock()
        supervisor._install_tools = MagicMock()
        supervisor._install_skills = MagicMock()
        supervisor._install_bin_scripts = MagicMock()
        supervisor._wait_for_health = AsyncMock()

        await supervisor.start((), supervisor.workspace_path)

    destination = supervisor.workspace_path / ".opencode" / "plugins"
    assert mock_copy.call_args_list == [
        call(broker_source, destination / "provider-token-broker.js"),
        call(xai_source, destination / "xai-auth-plugin.js"),
        call(anthropic_source, destination / "anthropic-auth-plugin.js"),
    ]
    mock_excludes.assert_called_once_with(
        supervisor.workspace_path,
        {
            ".opencode/plugins/provider-token-broker.js",
            ".opencode/plugins/xai-auth-plugin.js",
            ".opencode/plugins/anthropic-auth-plugin.js",
        },
    )
