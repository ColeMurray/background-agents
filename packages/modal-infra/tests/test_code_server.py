"""Tests for code-server integration in SandboxManager and SandboxSupervisor."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.launch import SandboxLauncher
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls


class TestGenerateCodeServerPassword:
    """SandboxLauncher._generate_code_server_password tests."""

    def test_returns_nonempty_password(self):
        password = SandboxLauncher._generate_code_server_password()
        assert len(password) > 0

    def test_generates_unique_passwords(self):
        passwords = set()
        for _ in range(20):
            passwords.add(SandboxLauncher._generate_code_server_password())
        assert len(passwords) == 20


class TestCreateSandboxCodeServer:
    """create_sandbox populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_code_server_skipped_when_disabled(self, monkeypatch):
        """When code_server_enabled=False, no password, ports, or tunnel."""
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
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create)

        tunnel_mock = AsyncMock(return_value=TunnelUrls(None, None, None, None))
        monkeypatch.setattr(SandboxTunnels, "resolve", tunnel_mock)

        manager = SandboxManager()
        config = SandboxConfig(
            clone_host="github.com",
            clone_username="x-access-token",
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            code_server_enabled=False,
        )

        handle = await manager.create_sandbox(config)

        assert handle.code_server_url is None
        assert handle.code_server_password is None
        assert "CODE_SERVER_PASSWORD" not in captured["env"]
        assert captured["encrypted_ports"] is None


class TestRestoreSandboxCodeServer:
    """restore_from_snapshot populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_code_server_skipped_when_disabled(self, monkeypatch):
        """When code_server_enabled=False, restore skips code-server setup."""
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
        monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", fake_from_id)
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create)
        tunnel_mock = AsyncMock(return_value=TunnelUrls(None, None, None, None))
        monkeypatch.setattr(SandboxTunnels, "resolve", tunnel_mock)

        manager = SandboxManager()
        handle = await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
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

        assert handle.code_server_url is None
        assert handle.code_server_password is None
        assert "CODE_SERVER_PASSWORD" not in captured["env"]
        assert captured["encrypted_ports"] is None
