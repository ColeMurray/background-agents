"""Behavior matrix for shared fresh, repository-image, and snapshot launches."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
)
from sandbox_runtime.types import SessionConfig
from src.sandbox.manager import SandboxConfig, SandboxManager


def _fake_create(captured: dict):
    async def create_aio(*args, **kwargs):
        captured["command"] = args
        captured["kwargs"] = kwargs
        return SimpleNamespace(object_id="modal-object-1", stdout=None)

    create_aio.aio = create_aio
    return create_aio


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
async def test_launch_matrix_preserves_common_and_source_specific_behavior(
    monkeypatch, image_source
):
    captured: dict = {}
    base_image = object()
    images = {
        "repo-image-1": object(),
        "snapshot-image-1": object(),
    }
    monkeypatch.setattr("src.sandbox.manager.base_image", base_image)
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", images.__getitem__)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)
    resolve_tunnels = AsyncMock(
        return_value=(
            "https://code.example",
            "https://vnc.example",
            "https://terminal.example",
            {3000: "https://app.example"},
        )
    )
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        resolve_tunnels,
    )
    monkeypatch.setattr(
        SandboxManager, "_generate_code_server_password", staticmethod(lambda: "code-password")
    )
    monkeypatch.setattr(SandboxManager, "_generate_vnc_password", staticmethod(lambda: "vnc-pass"))

    manager = SandboxManager()
    settings = {
        "codeServerPort": 9000,
        "vncPort": 9001,
        "terminalPort": 9002,
        "terminalEnabled": True,
        "tunnelPorts": [3000],
        "cpuCores": 1.5,
        "memoryMib": 3072,
    }
    common = {
        "sandbox_id": "sandbox-1",
        "control_plane_url": "https://control.example",
        "sandbox_auth_token": "sandbox-token",
        "timeout_seconds": 4321,
        "user_env_vars": {
            "CONTROL_PLANE_URL": "https://user.example",
            "CUSTOM_ENV": "preserved",
            "RESTORED_FROM_SNAPSHOT": "true",
            "FROM_REPO_IMAGE": "false",
            "IMAGE_BUILD_MODE": "true",
            "TERMINAL_ENABLED": "false",
            "AGENT_SLACK_NOTIFY_ENABLED": "false",
            "SESSION_CONFIG": "malicious",
            VNC_PASSWORD_ENV_VAR: "user-vnc-password",
            NOVNC_PORT_ENV_VAR: "9999",
        },
        "code_server_enabled": True,
        "vnc_enabled": True,
        "agent_slack_notify_enabled": True,
        "settings": settings,
    }

    if image_source == "snapshot":
        handle = await manager.restore_from_snapshot(
            snapshot_image_id="snapshot-image-1",
            session_config={
                "session_id": "session-1",
                "repo_owner": "acme",
                "repo_name": "repo",
                "future_field": {"preserved": True},
            },
            clone_token="legacy-clone-token",
            **common,
        )
        expected_image = images["snapshot-image-1"]
    else:
        handle = await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                session_config=SessionConfig(
                    session_id="session-1",
                    repo_owner="acme",
                    repo_name="repo",
                    branch="feature/shared-launch",
                ),
                repo_image_id="repo-image-1" if image_source == "repository" else None,
                repo_image_sha="abc123" if image_source == "repository" else None,
                **common,
            )
        )
        expected_image = images["repo-image-1"] if image_source == "repository" else base_image

    kwargs = captured["kwargs"]
    env = kwargs["env"]
    assert captured["command"] == ("python", "-m", "sandbox_runtime.entrypoint")
    assert kwargs["image"] is expected_image
    assert kwargs["timeout"] == 4321
    assert kwargs["cpu"] == 1.5
    assert kwargs["memory"] == 3072
    assert kwargs["encrypted_ports"] == [9000, 9001, 9002, 3000]

    assert env["CONTROL_PLANE_URL"] == "https://control.example"
    assert env["CUSTOM_ENV"] == "preserved"
    assert env["CODE_SERVER_PASSWORD"] == "code-password"
    assert env[VNC_PASSWORD_ENV_VAR] == "vnc-pass"
    assert env[CODE_SERVER_PORT_ENV_VAR] == "9000"
    assert env[NOVNC_PORT_ENV_VAR] == "9001"
    assert env[TTYD_PROXY_PORT_ENV_VAR] == "9002"
    assert env[EXPECTED_TUNNEL_PORTS_ENV_VAR] == "3000"
    assert env["AGENT_SLACK_NOTIFY_ENABLED"] == "true"
    assert env["TERMINAL_ENABLED"] == "true"
    assert "IMAGE_BUILD_MODE" not in env

    if image_source == "repository":
        assert env["FROM_REPO_IMAGE"] == "true"
        assert env["REPO_IMAGE_SHA"] == "abc123"
    else:
        assert "FROM_REPO_IMAGE" not in env

    if image_source == "snapshot":
        assert env["RESTORED_FROM_SNAPSHOT"] == "true"
        assert '"future_field": {"preserved": true}' in env["SESSION_CONFIG"]
        assert env["VCS_CLONE_TOKEN"] == "legacy-clone-token"
        assert env["GITHUB_TOKEN"] == "legacy-clone-token"
        assert env["GITHUB_APP_TOKEN"] == "legacy-clone-token"
    else:
        assert "RESTORED_FROM_SNAPSHOT" not in env
        assert "VCS_CLONE_TOKEN" not in env
        session_config = json.loads(env["SESSION_CONFIG"])
        assert session_config["branch"] == "feature/shared-launch"

    assert handle.sandbox_id == "sandbox-1"
    assert handle.modal_object_id == "modal-object-1"
    assert handle.snapshot_id == ("snapshot-image-1" if image_source == "snapshot" else None)
    assert handle.code_server_url == "https://code.example"
    assert handle.code_server_password == "code-password"
    assert handle.vnc_url == "https://vnc.example"
    assert handle.vnc_password == "vnc-pass"
    assert handle.ttyd_url == "https://terminal.example"
    assert handle.tunnel_urls == {3000: "https://app.example"}
    resolve_tunnels.assert_awaited_once_with(
        handle.modal_sandbox,
        "sandbox-1",
        True,
        True,
        True,
        [3000],
        9000,
        9001,
        9002,
    )


@pytest.mark.asyncio
async def test_repository_image_create_validates_repo_before_image_lookup(monkeypatch):
    from_id = Mock(side_effect=AssertionError("image lookup should not run"))
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", from_id)

    with pytest.raises(ValueError, match="repo_owner and repo_name must be provided together"):
        await SandboxManager().create_sandbox(
            SandboxConfig(repo_owner="acme", repo_name=None, repo_image_id="repo-image-1")
        )

    from_id.assert_not_called()
