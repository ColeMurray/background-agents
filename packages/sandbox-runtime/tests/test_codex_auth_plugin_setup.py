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

    async def test_start_opencode_copies_js_plugin(self, tmp_path):
        """start_opencode() should deploy the precompiled JS plugin into .opencode/plugins."""
        sup = _make_supervisor()
        sup.workspace_path = tmp_path / "workspace"
        sup.workspace_path.mkdir()
        sup.repo_path = sup.workspace_path / "app"

        plugin_source = tmp_path / "app" / "sandbox_runtime" / "plugins" / "codex-auth-plugin.js"
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const CodexAuthProxy = async () => ({});")

        fake_proc = MagicMock()
        fake_proc.stdout = None

        original_path = Path

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_real_secret"}, clear=False),
            patch("sandbox_runtime.entrypoint.Path") as mock_path,
            patch("sandbox_runtime.entrypoint.shutil.copy") as mock_copy,
            patch("sandbox_runtime.entrypoint.asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)),
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
            sup._install_tools = MagicMock()
            sup._install_skills = MagicMock()
            sup._install_bin_scripts = MagicMock()
            sup._wait_for_health = AsyncMock()

            await sup.start_opencode()

        mock_copy.assert_called_once_with(
            plugin_source,
            sup.workspace_path / ".opencode" / "plugins" / "codex-auth-plugin.js",
        )
