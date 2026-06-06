"""Tests for ttyd web terminal integration in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.constants import CODE_SERVER_PORT, TTYD_PORT, TTYD_PROXY_PORT
from src.sandbox.manager import (
    SandboxConfig,
    SandboxManager,
)
from src.sandbox.settings import RuntimePortSettings, SandboxRuntimeSettings


def _settings(raw: dict | None = None) -> SandboxRuntimeSettings:
    return SandboxRuntimeSettings.from_raw(raw)


class TestCollectExposedPortsTerminal:
    """RuntimePortSettings with terminal_enabled flag."""

    def test_terminal_enabled_includes_proxy_port(self):
        ports = RuntimePortSettings.from_settings(
            _settings({"terminalEnabled": True}), code_server_enabled=False
        )
        assert TTYD_PROXY_PORT in ports.exposed_ports
        # ttyd raw port should NOT be exposed (only the proxy port)
        assert TTYD_PORT not in ports.exposed_ports

    def test_terminal_disabled_excludes_proxy_port(self):
        ports = RuntimePortSettings.from_settings(_settings(), code_server_enabled=False)
        assert TTYD_PROXY_PORT not in ports.exposed_ports

    def test_terminal_and_code_server_both_enabled(self):
        ports = RuntimePortSettings.from_settings(
            _settings({"terminalEnabled": True}), code_server_enabled=True
        )
        assert CODE_SERVER_PORT in ports.exposed_ports
        assert TTYD_PROXY_PORT in ports.exposed_ports

    def test_terminal_port_deduped_from_tunnel_ports(self):
        """If user explicitly lists TTYD_PROXY_PORT in tunnelPorts, it should not duplicate."""
        settings = _settings({"terminalEnabled": True, "tunnelPorts": [TTYD_PROXY_PORT, 3000]})
        ports = RuntimePortSettings.from_settings(settings, code_server_enabled=False)
        assert ports.exposed_ports.count(TTYD_PROXY_PORT) == 1
        assert 3000 in ports.exposed_ports
        # TTYD_PROXY_PORT should not be in extra (reserved)
        assert TTYD_PROXY_PORT not in ports.tunnel_ports
        assert 3000 in ports.tunnel_ports


class TestResolveTunnelsTerminal:
    """_resolve_and_setup_tunnels extracts ttyd_url from resolved tunnels."""

    @pytest.mark.asyncio
    async def test_returns_ttyd_url_when_terminal_enabled(self):
        tunnel = MagicMock()
        tunnel.url = "https://ttyd.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {TTYD_PROXY_PORT: tunnel}

        cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
            sandbox, "sb-123", code_server_enabled=False, terminal_enabled=True, extra_ports=[]
        )
        assert cs_url is None
        assert ttyd_url == "https://ttyd.example.com"
        assert extra is None

    @pytest.mark.asyncio
    async def test_returns_none_when_terminal_disabled(self):
        sandbox = MagicMock()
        cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
            sandbox, "sb-123", code_server_enabled=False, terminal_enabled=False, extra_ports=[]
        )
        assert cs_url is None
        assert ttyd_url is None
        assert extra is None

    @pytest.mark.asyncio
    async def test_both_code_server_and_terminal(self):
        cs_tunnel = MagicMock()
        cs_tunnel.url = "https://cs.example.com"
        ttyd_tunnel = MagicMock()
        ttyd_tunnel.url = "https://ttyd.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {
            CODE_SERVER_PORT: cs_tunnel,
            TTYD_PROXY_PORT: ttyd_tunnel,
        }

        cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
            sandbox,
            "sb-123",
            code_server_enabled=True,
            terminal_enabled=True,
            extra_ports=[],
        )
        assert cs_url == "https://cs.example.com"
        assert ttyd_url == "https://ttyd.example.com"
        assert extra is None


class TestCreateSandboxTerminal:
    """create_sandbox populates ttyd fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_ttyd_url(self, monkeypatch):
        captured = {}

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-123"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, "https://ttyd.example.com", None)),
        )

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            code_server_enabled=False,
            settings=_settings({"terminalEnabled": True}),
        )

        handle = await manager.create_sandbox(config)

        assert handle.ttyd_url == "https://ttyd.example.com"
        assert captured["env"]["TERMINAL_ENABLED"] == "true"
        assert TTYD_PROXY_PORT in captured["encrypted_ports"]

    @pytest.mark.asyncio
    async def test_ttyd_skipped_when_disabled(self, monkeypatch):
        captured = {}

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-123"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

        tunnel_mock = AsyncMock(return_value=(None, None, None))
        monkeypatch.setattr(SandboxManager, "_resolve_and_setup_tunnels", tunnel_mock)

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            code_server_enabled=False,
        )

        handle = await manager.create_sandbox(config)

        assert handle.ttyd_url is None
        assert "TERMINAL_ENABLED" not in captured["env"]
        assert captured["encrypted_ports"] is None


class TestRestoreSandboxTerminal:
    """restore_from_snapshot populates ttyd fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_ttyd_url(self, monkeypatch):
        captured = {}

        class FakeImage:
            object_id = "img-123"

        def fake_from_id(*args, **kwargs):
            return FakeImage()

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-456"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, "https://ttyd-restored.example.com", None)),
        )

        manager = SandboxManager()
        handle = await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={
                "repo_owner": "acme",
                "repo_name": "repo",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "session_id": "sess-1",
            },
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-456",
            code_server_enabled=False,
            settings=_settings({"terminalEnabled": True}),
        )

        assert handle.ttyd_url == "https://ttyd-restored.example.com"
        assert captured["env"]["TERMINAL_ENABLED"] == "true"
        assert TTYD_PROXY_PORT in captured["encrypted_ports"]

    @pytest.mark.asyncio
    async def test_ttyd_skipped_when_disabled(self, monkeypatch):
        captured = {}

        class FakeImage:
            object_id = "img-123"

        def fake_from_id(*args, **kwargs):
            return FakeImage()

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-456"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
        tunnel_mock = AsyncMock(return_value=(None, None, None))
        monkeypatch.setattr(SandboxManager, "_resolve_and_setup_tunnels", tunnel_mock)

        manager = SandboxManager()
        handle = await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={
                "repo_owner": "acme",
                "repo_name": "repo",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "session_id": "sess-1",
            },
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-456",
            code_server_enabled=False,
        )

        assert handle.ttyd_url is None
        assert "TERMINAL_ENABLED" not in captured["env"]
        assert captured["encrypted_ports"] is None
