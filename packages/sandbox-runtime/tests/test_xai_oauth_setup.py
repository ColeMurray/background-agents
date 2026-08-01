"""Tests for managed xAI OAuth setup and plugin deployment."""

import json
import subprocess
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
            clear=False,
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
        patch.dict("os.environ", {"XAI_OAUTH_MANAGED": "1"}, clear=False),
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


def test_xai_plugin_uses_broker_without_refresh_token_environment():
    plugin = (
        Path(__file__).parents[1] / "src" / "sandbox_runtime" / "plugins" / "xai-auth-plugin.js"
    ).read_text()

    assert 'provider: "xai"' in plugin
    assert "/xai-token-refresh" in plugin
    assert "XAI_OAUTH_REFRESH_TOKEN" not in plugin


def test_xai_plugin_registers_complete_grok_build_model():
    plugin_uri = (
        Path(__file__).parents[1] / "src" / "sandbox_runtime" / "plugins" / "xai-auth-plugin.js"
    ).as_uri()
    script = f"""
      const {{ XaiAuthProxy }} = await import({json.dumps(plugin_uri)});
      const hooks = await XaiAuthProxy();
      const base = {{
        id: "grok-code-fast-1", providerID: "xai",
        api: {{ id: "grok-code-fast-1", url: "https://api.x.ai/v1", npm: "@ai-sdk/xai" }},
        name: "Grok Code Fast 1", capabilities: {{ reasoning: true }},
        cost: {{ input: 1, output: 2, cache: {{ read: 0, write: 0 }} }},
        limit: {{ context: 256000, output: 10000 }}, status: "active",
        options: {{}}, headers: {{}}, release_date: "2025-08-28"
      }};
      const models = await hooks.provider.models({{ models: {{ "grok-code-fast-1": base }} }});
      console.log(JSON.stringify(models["grok-build-0.1"]));
    """

    result = subprocess.run(["bun", "--eval", script], check=True, capture_output=True, text=True)
    model = json.loads(result.stdout)

    assert model["id"] == "grok-build-0.1"
    assert model["providerID"] == "xai"
    assert model["api"]["id"] == "grok-build-0.1"
    assert model["variants"]["high"] == {"reasoningEffort": "high"}
    assert model["cost"] == {"input": 0, "output": 0, "cache": {"read": 0, "write": 0}}


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
        patch.dict("os.environ", {"XAI_OAUTH_MANAGED": "1"}, clear=False),
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
