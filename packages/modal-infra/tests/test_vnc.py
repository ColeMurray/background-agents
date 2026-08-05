"""Tests for VNC/noVNC integration in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import (
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
    VNC_PASSWORD_MAX_BYTES,
    VNC_PORT,
)
from src.sandbox.manager import CODE_SERVER_PORT, TTYD_PROXY_PORT, SandboxConfig, SandboxManager


def _patch_sandbox_create(monkeypatch, captured: dict) -> None:
    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        captured["encrypted_ports"] = kwargs.get("encrypted_ports")

        class FakeSandbox:
            object_id = "obj-vnc"
            stdout = None

        return FakeSandbox()

    fake_create = MagicMock()
    fake_create.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)


class TestCreateSandboxVnc:
    @pytest.mark.asyncio
    async def test_returns_url_and_password_and_exposes_only_novnc(self, monkeypatch):
        captured = {}
        _patch_sandbox_create(monkeypatch, captured)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, "https://vnc.example.com", None, None)),
        )

        handle = await SandboxManager().create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                vnc_enabled=True,
                settings={"vncPort": 6081, "tunnelPorts": [VNC_PORT]},
            )
        )

        assert handle.vnc_url == "https://vnc.example.com"
        assert handle.vnc_password
        assert len(handle.vnc_password.encode()) == VNC_PASSWORD_MAX_BYTES
        assert captured["env"][VNC_PASSWORD_ENV_VAR] == handle.vnc_password
        assert captured["env"][NOVNC_PORT_ENV_VAR] == "6081"
        assert captured["encrypted_ports"] == [6081]
        assert VNC_PORT not in captured["encrypted_ports"]

    @pytest.mark.asyncio
    async def test_disabled_vnc_has_no_credentials_or_port(self, monkeypatch):
        captured = {}
        _patch_sandbox_create(monkeypatch, captured)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None, None)),
        )

        handle = await SandboxManager().create_sandbox(
            SandboxConfig(repo_owner="acme", repo_name="repo")
        )

        assert handle.vnc_url is None
        assert handle.vnc_password is None
        assert VNC_PASSWORD_ENV_VAR not in captured["env"]
        assert NOVNC_PORT_ENV_VAR not in captured["env"]
        assert captured["encrypted_ports"] is None


class TestRestoreSandboxVnc:
    @pytest.mark.asyncio
    async def test_generates_credentials_and_returns_them_with_url(self, monkeypatch):
        captured = {}
        _patch_sandbox_create(monkeypatch, captured)
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *_args: MagicMock())
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, "https://restored-vnc.example.com", None, None)),
        )

        handle = await SandboxManager().restore_from_snapshot(
            snapshot_image_id="img-1",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            vnc_enabled=True,
        )

        assert handle.vnc_url == "https://restored-vnc.example.com"
        assert handle.vnc_password
        assert captured["env"][VNC_PASSWORD_ENV_VAR] == handle.vnc_password
        assert captured["env"][NOVNC_PORT_ENV_VAR] == str(NOVNC_PORT)
        assert captured["encrypted_ports"] == [NOVNC_PORT]


@pytest.mark.asyncio
async def test_resolves_custom_novnc_tunnel():
    sandbox = MagicMock()
    with patch.object(
        SandboxManager,
        "_resolve_tunnels",
        new_callable=AsyncMock,
        return_value={6081: "https://vnc.example.com"},
    ) as resolve_tunnels:
        result = await SandboxManager._resolve_and_setup_tunnels(
            sandbox,
            "sandbox-vnc",
            False,
            True,
            False,
            [],
            code_server_port=CODE_SERVER_PORT,
            novnc_port=6081,
            ttyd_proxy_port=TTYD_PROXY_PORT,
        )

    resolve_tunnels.assert_awaited_once_with(sandbox, "sandbox-vnc", [6081])
    assert result == (None, "https://vnc.example.com", None, None)


def test_raw_vnc_port_is_never_exposed_as_an_extra_tunnel():
    exposed, extras = SandboxManager._collect_exposed_ports(
        False,
        False,
        False,
        {"tunnelPorts": [VNC_PORT, 3000]},
        CODE_SERVER_PORT,
        NOVNC_PORT,
        TTYD_PROXY_PORT,
    )

    assert exposed == [3000]
    assert extras == [3000]
