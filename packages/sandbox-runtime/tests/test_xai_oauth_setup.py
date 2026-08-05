"""Tests for managed xAI OAuth setup and plugin deployment."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
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
        return SandboxSupervisor()


def test_auth_json_merges_openai_and_xai_entries(tmp_path):
    supervisor = _make_supervisor()
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"

    with (
        patch.dict(
            "os.environ",
            {"OPENAI_OAUTH_MANAGED": "1", "XAI_OAUTH_MANAGED": "1"},
            clear=True,
        ),
        patch("pathlib.Path.home", return_value=tmp_path),
    ):
        supervisor._setup_managed_oauth()

    assert json.loads(auth_file.read_text()) == {
        "openai": {
            "type": "oauth",
            "refresh": "managed-by-control-plane",
            "access": "",
            "expires": 0,
        },
        "xai": {
            "type": "oauth",
            "refresh": "managed-by-control-plane",
            "access": "",
            "expires": 0,
        },
    }
    assert auth_file.stat().st_mode & 0o777 == 0o600


def test_auth_json_preserves_existing_provider_entries(tmp_path):
    supervisor = _make_supervisor()
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(json.dumps({"anthropic": {"type": "api", "key": "existing"}}))

    with (
        patch.dict("os.environ", {"XAI_OAUTH_MANAGED": "1"}, clear=True),
        patch("pathlib.Path.home", return_value=tmp_path),
    ):
        supervisor._setup_managed_oauth()

    assert json.loads(auth_file.read_text()) == {
        "anthropic": {"type": "api", "key": "existing"},
        "xai": {
            "type": "oauth",
            "refresh": "managed-by-control-plane",
            "access": "",
            "expires": 0,
        },
    }


def test_auth_json_removes_stale_managed_provider_entries(tmp_path):
    supervisor = _make_supervisor()
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(
        json.dumps(
            {
                "anthropic": {"type": "api", "key": "existing"},
                "openai": {
                    "type": "oauth",
                    "refresh": "managed-by-control-plane",
                    "access": "old",
                    "expires": 1,
                },
            }
        )
    )

    with (
        patch.dict("os.environ", {"XAI_OAUTH_MANAGED": "1"}, clear=True),
        patch("pathlib.Path.home", return_value=tmp_path),
    ):
        supervisor._setup_managed_oauth()

    data = json.loads(auth_file.read_text())
    assert data["anthropic"] == {"type": "api", "key": "existing"}
    assert "openai" not in data
    assert data["xai"]["refresh"] == "managed-by-control-plane"


def test_xai_plugin_uses_broker_without_refresh_token_environment():
    plugin = (
        Path(__file__).parents[1] / "src" / "sandbox_runtime" / "plugins" / "xai-auth-plugin.js"
    ).read_text()

    assert 'provider: "xai"' in plugin
    assert "/xai-token-refresh" in plugin
    assert "XAI_OAUTH_REFRESH_TOKEN" not in plugin
    assert "reasoningEffort" not in plugin


async def test_start_opencode_deploys_xai_plugin_from_marker(tmp_path):
    supervisor = _make_supervisor()
    supervisor.workspace_path = tmp_path / "workspace"
    supervisor.workspace_path.mkdir()
    (supervisor.workspace_path / ".git").mkdir()
    supervisor.repo_path = supervisor.workspace_path / "app"
    plugin_source = tmp_path / "app" / "sandbox_runtime" / "plugins" / "xai-auth-plugin.js"
    plugin_source.parent.mkdir(parents=True)
    plugin_source.write_text("export const XaiAuthProxy = async () => ({});")
    fake_proc = MagicMock(stdout=None)
    original_path = Path

    with (
        patch.dict("os.environ", {"XAI_OAUTH_MANAGED": "1"}, clear=True),
        patch("sandbox_runtime.entrypoint.Path") as mock_path,
        patch("sandbox_runtime.entrypoint.shutil.copy") as mock_copy,
        patch("sandbox_runtime.entrypoint.install_runtime_git_excludes") as mock_excludes,
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=fake_proc),
        ),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_task", side_effect=lambda coro: coro.close()
        ),
    ):
        mock_path.side_effect = lambda value: (
            plugin_source
            if value == "/app/sandbox_runtime/plugins/xai-auth-plugin.js"
            else original_path(value)
        )
        supervisor._setup_managed_oauth = MagicMock()
        supervisor._install_tools = MagicMock()
        supervisor._install_skills = MagicMock()
        supervisor._install_bin_scripts = MagicMock()
        supervisor._wait_for_health = AsyncMock()

        await supervisor.start_opencode()

    mock_copy.assert_called_once_with(
        plugin_source,
        supervisor.workspace_path / ".opencode" / "plugins" / "xai-auth-plugin.js",
    )
    mock_excludes.assert_called_once_with(
        supervisor.workspace_path,
        {".opencode/plugins/xai-auth-plugin.js"},
    )
