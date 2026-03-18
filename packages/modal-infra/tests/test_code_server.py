"""Tests for code-server integration in SandboxManager and SandboxSupervisor."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.manager import CODE_SERVER_PORT, SandboxConfig, SandboxManager


class TestGenerateCodeServerPassword:
    """SandboxManager._generate_code_server_password tests."""

    def test_returns_nonempty_password(self):
        password = SandboxManager._generate_code_server_password()
        assert len(password) > 0

    def test_generates_unique_passwords(self):
        passwords = set()
        for _ in range(20):
            passwords.add(SandboxManager._generate_code_server_password())
        assert len(passwords) == 20


class TestResolveCodeServerTunnel:
    """SandboxManager._resolve_code_server_tunnel tests."""

    @pytest.mark.asyncio
    async def test_returns_tunnel_url_on_success(self):
        tunnel = MagicMock()
        tunnel.url = "https://tunnel.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {CODE_SERVER_PORT: tunnel}

        url = await SandboxManager._resolve_code_server_tunnel(sandbox, "sb-123")
        assert url == "https://tunnel.example.com"

    @pytest.mark.asyncio
    async def test_returns_none_on_exception_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.side_effect = Exception("tunnel unavailable")

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=2, backoff=0.0
            )
        assert url is None
        assert sandbox.tunnels.call_count == 2

    @pytest.mark.asyncio
    async def test_returns_none_when_port_missing_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.return_value = {}  # no entry for CODE_SERVER_PORT

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=2, backoff=0.0
            )
        assert url is None

    @pytest.mark.asyncio
    async def test_retries_then_succeeds(self):
        tunnel = MagicMock()
        tunnel.url = "https://tunnel.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.side_effect = [
            Exception("not ready"),
            {CODE_SERVER_PORT: tunnel},
        ]

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=3, backoff=0.0
            )
        assert url == "https://tunnel.example.com"
        assert sandbox.tunnels.call_count == 2


class TestCreateSandboxCodeServer:
    """create_sandbox populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_code_server_fields(self, monkeypatch):
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
            "_resolve_code_server_tunnel",
            AsyncMock(return_value="https://cs.example.com"),
        )

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            code_server_enabled=True,
        )

        handle = await manager.create_sandbox(config)

        assert handle.code_server_url == "https://cs.example.com"
        assert handle.code_server_password is not None
        assert len(handle.code_server_password) > 0
        # Password should be injected into sandbox env vars
        assert captured["env"]["CODE_SERVER_PASSWORD"] == handle.code_server_password
        # Code-server port should be in encrypted_ports
        assert captured["encrypted_ports"] == [CODE_SERVER_PORT]

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
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

        tunnel_mock = AsyncMock(return_value="https://cs.example.com")
        monkeypatch.setattr(SandboxManager, "_resolve_code_server_tunnel", tunnel_mock)

        manager = SandboxManager()
        config = SandboxConfig(
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
        tunnel_mock.assert_not_called()


class TestRestoreSandboxCodeServer:
    """restore_from_snapshot populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_code_server_fields(self, monkeypatch):
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
            "_resolve_code_server_tunnel",
            AsyncMock(return_value="https://cs-restored.example.com"),
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
            code_server_enabled=True,
        )

        assert handle.code_server_url == "https://cs-restored.example.com"
        assert handle.code_server_password is not None
        assert captured["env"]["CODE_SERVER_PASSWORD"] == handle.code_server_password
        assert captured["encrypted_ports"] == [CODE_SERVER_PORT]

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
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
        tunnel_mock = AsyncMock(return_value="https://cs.example.com")
        monkeypatch.setattr(SandboxManager, "_resolve_code_server_tunnel", tunnel_mock)

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

        assert handle.code_server_url is None
        assert handle.code_server_password is None
        assert "CODE_SERVER_PASSWORD" not in captured["env"]
        assert captured["encrypted_ports"] is None
        tunnel_mock.assert_not_called()
