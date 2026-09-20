"""Behavior matrix for shared fresh, repository-image, and snapshot launches."""

import asyncio
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
from src.sandbox.manager import (
    RepositoryImageUnavailableError,
    SandboxConfig,
    SandboxManager,
    SnapshotImageUnavailableError,
)


def _fake_create(captured: dict):
    async def create_aio(*args, **kwargs):
        captured["command"] = args
        captured["kwargs"] = kwargs
        return SimpleNamespace(object_id="modal-object-1", stdout=None)

    create_aio.aio = create_aio
    return create_aio


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
@pytest.mark.parametrize("docker_enabled", [False, True])
async def test_launch_matrix_preserves_common_and_source_specific_behavior(
    monkeypatch, image_source, docker_enabled
):
    captured: dict = {}
    base_image = object()
    docker_image = object()
    execution = (
        {"profile": "docker-v1", "provider": "modal", "cpuCores": 2, "memoryMib": 4096}
        if docker_enabled
        else {"profile": "default"}
    )
    monkeypatch.setattr("src.images.base.docker_image", docker_image)
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
        "dockerEnabled": docker_enabled,
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
        "allocation_name": "session-sandbox-1" if docker_enabled else None,
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
                "sandbox_execution": execution,
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
                    sandbox_execution=execution,
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
        expected_image = (
            images["repo-image-1"]
            if image_source == "repository"
            else docker_image
            if docker_enabled
            else base_image
        )

    kwargs = captured["kwargs"]
    env = kwargs["env"]
    assert captured["command"] == ("python", "-m", "sandbox_runtime.entrypoint")
    assert kwargs["image"] is expected_image
    assert kwargs["timeout"] == 4321
    assert kwargs["cpu"] == (2 if docker_enabled else 1.5)
    assert kwargs["memory"] == (4096 if docker_enabled else 3072)
    assert kwargs.get("experimental_options") == ({"vm_runtime": True} if docker_enabled else None)
    assert json.loads(env["SESSION_CONFIG"])["sandbox_execution"] == execution
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


@pytest.mark.asyncio
async def test_repository_image_not_found_is_reported_explicitly(monkeypatch):
    from modal.exception import NotFoundError

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda _image_id: object())
    create = SimpleNamespace(aio=AsyncMock(side_effect=NotFoundError("image not found")))
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)

    with pytest.raises(RepositoryImageUnavailableError):
        await SandboxManager().create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                repo_image_id="repo-image-missing",
            )
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("image_missing", [True, False])
async def test_create_not_found_only_latches_a_confirmed_missing_snapshot(
    monkeypatch, image_missing
):
    from modal.exception import NotFoundError

    lookup = AsyncMock(side_effect=NotFoundError("missing image") if image_missing else None)
    image = SimpleNamespace(build=SimpleNamespace(aio=lookup))
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda _: image)
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.create",
        SimpleNamespace(aio=AsyncMock(side_effect=NotFoundError("create failed"))),
    )
    expected = SnapshotImageUnavailableError if image_missing else NotFoundError
    with pytest.raises(expected):
        await SandboxManager().restore_from_snapshot("im-test", {"session_id": "s1"})
    lookup.assert_awaited_once()


@pytest.mark.asyncio
async def test_tunnel_failure_terminates_known_allocation(monkeypatch):
    terminate = AsyncMock()
    sandbox = SimpleNamespace(object_id="sb-owned", terminate=SimpleNamespace(aio=terminate))
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.create",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(side_effect=RuntimeError("tunnel setup")),
    )
    with pytest.raises(RuntimeError, match="tunnel setup"):
        await SandboxManager().create_sandbox(SandboxConfig(repo_owner=None, repo_name=None))
    terminate.assert_awaited_once()


@pytest.mark.asyncio
async def test_allocation_cleanup_is_bounded_despite_repeated_cancellation(monkeypatch):
    started = asyncio.Event()

    async def terminate():
        started.set()
        await asyncio.Event().wait()

    sandbox = SimpleNamespace(object_id="sb-owned", terminate=SimpleNamespace(aio=terminate))
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.create",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(side_effect=RuntimeError("tunnel setup")),
    )
    timeout = asyncio.timeout
    monkeypatch.setattr("src.sandbox.manager.asyncio.timeout", lambda _: timeout(0.03))
    task = asyncio.create_task(
        SandboxManager().create_sandbox(SandboxConfig(repo_owner=None, repo_name=None))
    )
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises((TimeoutError, asyncio.CancelledError)):
        await asyncio.wait_for(task, 1)
