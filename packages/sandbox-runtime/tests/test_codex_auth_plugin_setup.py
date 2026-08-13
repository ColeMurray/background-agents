"""Tests for codex auth proxy plugin deployment in OpenCodeServer."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.opencode_server import OpenCodeServer
from tests.runtime_helpers import make_opencode_server


def _make_opencode_server() -> OpenCodeServer:
    """Create an OpenCodeServer with default test config."""
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
        sup = _make_opencode_server()

        with (
            patch.dict(
                "os.environ",
                {"OPENAI_OAUTH_MANAGED": "1"},
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert data["openai"]["type"] == "oauth"
        assert data["openai"]["access"] == ""
        assert data["openai"]["expires"] == 0

    def test_auth_json_does_not_include_account_id(self, tmp_path):
        """The broker returns account IDs with access tokens when needed."""
        sup = _make_opencode_server()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_MANAGED": "1",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert "accountId" not in data["openai"]

    async def test_start_copies_js_plugin(self, tmp_path):
        sup = _make_opencode_server()
        sup.workspace_path = tmp_path / "workspace"
        sup.workspace_path.mkdir()
        (sup.workspace_path / ".git").mkdir()
        sup.repo_path = sup.workspace_path / "app"

        plugin_source = tmp_path / "app" / "sandbox_runtime" / "plugins" / "codex-auth-plugin.js"
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const CodexAuthProxy = async () => ({});")

        fake_proc = MagicMock()
        fake_proc.stdout = None

        original_path = Path

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=True),
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
            mock_path.side_effect = lambda p: (
                plugin_source
                if p == "/app/sandbox_runtime/plugins/codex-auth-plugin.js"
                else original_path(p)
            )
            sup._setup_managed_oauth = MagicMock()
            sup._install_tools = MagicMock()
            sup._install_skills = MagicMock()
            sup._install_bin_scripts = MagicMock()
            sup._wait_for_health = AsyncMock()

            await sup.start((), sup.workspace_path)

        mock_copy.assert_called_once_with(
            plugin_source,
            sup.workspace_path / ".opencode" / "plugins" / "codex-auth-plugin.js",
        )
        mock_excludes.assert_called_once_with(
            sup.workspace_path,
            {".opencode/plugins/codex-auth-plugin.js"},
        )
