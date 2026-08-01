"""Tests for codex auth proxy plugin deployment in SandboxSupervisor."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with default test config."""
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


def _auth_file(tmp_path: Path) -> Path:
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestCodexAuthPluginSetup:
    """Cases for codex auth proxy plugin deployment."""

    def test_oauth_proxy_allows_gpt_5_6_models(self):
        """The OAuth model filter should retain all GPT-5.6 variants."""
        plugin_source = (
            Path(__file__).parents[1]
            / "src"
            / "sandbox_runtime"
            / "plugins"
            / "codex-auth-plugin.js"
        ).read_text()

        for model in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"):
            assert f'"{model}"' in plugin_source

    def test_oauth_proxy_excludes_unsupported_gpt_5_2_models(self):
        """The OAuth model filter should remove unsupported GPT-5.2 variants."""
        plugin_source = (
            Path(__file__).parents[1]
            / "src"
            / "sandbox_runtime"
            / "plugins"
            / "codex-auth-plugin.js"
        ).read_text()

        for model in ("gpt-5.2", "gpt-5.2-codex"):
            assert f'"{model}"' not in plugin_source

    def test_auth_json_uses_sentinel_token(self, tmp_path):
        """auth.json should contain the sentinel, not the real refresh token."""
        sup = _make_supervisor()

        with (
            patch.dict(
                "os.environ",
                {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_real_secret"},
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert data["openai"]["type"] == "oauth"
        assert data["openai"]["access"] == ""
        assert data["openai"]["expires"] == 0

    def test_auth_json_still_includes_account_id(self, tmp_path):
        """Account ID should still be written if present."""
        sup = _make_supervisor()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert data["openai"]["accountId"] == "acct_xyz"

    async def test_start_opencode_copies_js_plugin_outside_checkout(self, tmp_path):
        """start_opencode() should deploy the JS plugin into runtime-owned config."""
        sup = _make_supervisor()
        sup.workspace_path = tmp_path / "workspace"
        sup.workspace_path.mkdir()
        (sup.workspace_path / ".git").mkdir()
        sup.repo_path = sup.workspace_path / "app"

        plugin_source = tmp_path / "app" / "sandbox_runtime" / "plugins" / "codex-auth-plugin.js"
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const CodexAuthProxy = async () => ({});")
        runtime_config = tmp_path / "runtime-config"

        fake_proc = MagicMock()
        fake_proc.stdout = None

        original_path = Path

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_real_secret",
                    "OPENCODE_CONFIG_DIR": "/user/supplied",
                },
                clear=False,
            ),
            patch("sandbox_runtime.entrypoint.OPENCODE_RUNTIME_CONFIG_DIR", str(runtime_config)),
            patch("sandbox_runtime.entrypoint.Path") as mock_path,
            patch("sandbox_runtime.entrypoint.shutil.copy") as mock_copy,
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                AsyncMock(return_value=fake_proc),
            ) as mock_exec,
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_task",
                side_effect=lambda coro: coro.close(),
            ),
        ):
            mock_path.side_effect = lambda p: (
                plugin_source
                if p == "/app/sandbox_runtime/plugins/codex-auth-plugin.js"
                else original_path(p)
            )
            sup._setup_openai_oauth = MagicMock()
            sup._prepare_opencode_filesystem = MagicMock()
            sup._wait_for_health = AsyncMock()

            await sup.start_opencode()

        mock_copy.assert_called_once_with(
            plugin_source,
            runtime_config / "plugins" / "codex-auth-plugin.js",
        )
        sup._prepare_opencode_filesystem.assert_called_once_with(runtime_config)
        assert not (sup.workspace_path / ".opencode").exists()
        assert mock_exec.await_args.kwargs["env"]["OPENCODE_CONFIG_DIR"] == str(runtime_config)
