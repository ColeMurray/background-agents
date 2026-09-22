"""Behavior matrix for shared fresh, repository-image, and snapshot launches."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    DOCKER_ENABLED_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
)
from sandbox_runtime.types import SessionConfig
from src.sandbox.docker_launch import (
    DockerImageUnavailableError,
    InvalidDockerSettingsError,
    docker_allocation_name,
    docker_allocation_tags,
)
from src.sandbox.manager import (
    RepositoryImageUnavailableError,
    SandboxConfig,
    SandboxManager,
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
    # The default launch never touches the VM runtime or named allocations.
    assert "experimental_options" not in kwargs
    assert "name" not in kwargs
    assert "tags" not in kwargs
    assert env[DOCKER_ENABLED_ENV_VAR] == "false"

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


DOCKER_SETTINGS = {"dockerEnabled": True, "cpuCores": 2, "memoryMib": 4096}


def _docker_manager(monkeypatch) -> tuple[SandboxManager, dict, object]:
    captured: dict = {}
    docker_image = object()
    monkeypatch.setattr("src.sandbox.manager.base_image", object())
    monkeypatch.setattr("src.sandbox.docker_launch.docker_image", docker_image)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_create(captured))
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None, {})),
    )
    return SandboxManager(), captured, docker_image


def _docker_config(**overrides) -> SandboxConfig:
    fields = {
        "repo_owner": "acme",
        "repo_name": "repo",
        "sandbox_id": "sandbox-acme-repo-1700000000000",
        "session_config": SessionConfig(
            session_id="session-1", repo_owner="acme", repo_name="repo"
        ),
        "control_plane_url": "https://control.example",
        "sandbox_auth_token": "token",
        "user_env_vars": {DOCKER_ENABLED_ENV_VAR: "false", "CUSTOM_ENV": "preserved"},
        "settings": dict(DOCKER_SETTINGS),
    }
    return SandboxConfig(**{**fields, **overrides})


def _not_found(*_args, **_kwargs):
    from modal.exception import NotFoundError

    raise NotFoundError("no sandbox")


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
async def test_docker_launch_selects_vm_runtime_and_named_allocation(monkeypatch, image_source):
    manager, captured, docker_image = _docker_manager(monkeypatch)
    artifact = object()
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda _id: artifact)
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=_not_found)),
    )

    if image_source == "snapshot":
        handle = await manager.restore_from_snapshot(
            snapshot_image_id="snapshot-1",
            session_config={"session_id": "session-1", "repo_owner": "acme", "repo_name": "repo"},
            sandbox_id="sandbox-acme-repo-1700000000000",
            control_plane_url="https://control.example",
            sandbox_auth_token="token",
            user_env_vars={DOCKER_ENABLED_ENV_VAR: "false"},
            settings=dict(DOCKER_SETTINGS),
        )
    else:
        handle = await manager.create_sandbox(
            _docker_config(repo_image_id="repo-image-1" if image_source == "repository" else None)
        )

    kwargs = captured["kwargs"]
    assert kwargs["image"] is (docker_image if image_source == "base" else artifact)
    assert kwargs["experimental_options"] == {"vm_runtime": True}
    assert kwargs["cpu"] == 2.0
    assert kwargs["memory"] == 4096
    assert kwargs["name"] == docker_allocation_name("session-1", "sandbox-acme-repo-1700000000000")
    assert kwargs["tags"] == docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000")
    # The trusted signal wins over any user-supplied value.
    assert kwargs["env"][DOCKER_ENABLED_ENV_VAR] == "true"
    assert handle.docker_enabled is True


@pytest.mark.asyncio
async def test_docker_launch_without_a_provisioned_image_never_uses_the_default(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr("src.sandbox.docker_launch.docker_image", None)

    with pytest.raises(DockerImageUnavailableError):
        await manager.create_sandbox(_docker_config())

    assert "kwargs" not in captured


@pytest.mark.asyncio
async def test_malformed_docker_setting_fails_before_any_launch(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)

    with pytest.raises(InvalidDockerSettingsError):
        await manager.create_sandbox(_docker_config(settings={"dockerEnabled": "true"}))

    assert "kwargs" not in captured


@pytest.mark.asyncio
async def test_docker_launch_adopts_an_existing_owned_allocation(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    tags = docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000")
    existing = SimpleNamespace(object_id="modal-existing", get_tags=AsyncMock(return_value=tags))
    existing.get_tags.aio = existing.get_tags
    from_name = AsyncMock(return_value=existing)
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    handle = await manager.create_sandbox(_docker_config())

    assert "kwargs" not in captured
    assert handle.modal_object_id == "modal-existing"
    from_name.assert_awaited_once_with(
        "open-inspect", docker_allocation_name("session-1", "sandbox-acme-repo-1700000000000")
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("create_race", [False, True])
@pytest.mark.parametrize("image_source", ["base", "snapshot"])
async def test_docker_retry_returns_the_original_access_credentials(
    monkeypatch, create_race, image_source
):
    from modal.exception import AlreadyExistsError, NotFoundError

    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda _id: object())
    monkeypatch.setattr(
        SandboxManager, "_generate_code_server_password", Mock(side_effect=["original", "new"])
    )
    monkeypatch.setattr(
        SandboxManager, "_generate_vnc_password", Mock(side_effect=["old-vnc", "new-vnc"])
    )
    from_name = AsyncMock(side_effect=NotFoundError("not created"))
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    async def launch():
        config = _docker_config(code_server_enabled=True, vnc_enabled=True)
        if image_source == "base":
            return await manager.create_sandbox(config)
        return await manager.restore_from_snapshot(
            snapshot_image_id="snapshot-1",
            session_config=config.session_config,
            sandbox_id=config.sandbox_id,
            code_server_enabled=True,
            vnc_enabled=True,
            settings=config.settings,
        )

    original = await launch()
    original_env = captured["kwargs"]["env"]
    credential_output = json.dumps(
        {key: original_env[key] for key in ("CODE_SERVER_PASSWORD", VNC_PASSWORD_ENV_VAR)}
    )
    process = SimpleNamespace(
        stdout=SimpleNamespace(read=SimpleNamespace(aio=AsyncMock(return_value=credential_output))),
        wait=SimpleNamespace(aio=AsyncMock(return_value=0)),
    )
    existing = SimpleNamespace(
        object_id=original.modal_object_id,
        get_tags=SimpleNamespace(aio=AsyncMock(return_value=captured["kwargs"]["tags"])),
        exec=SimpleNamespace(aio=AsyncMock(return_value=process)),
    )
    from_name.side_effect = [NotFoundError("racing"), existing] if create_race else [existing]
    create = AsyncMock(side_effect=AlreadyExistsError("already created"))
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", SimpleNamespace(aio=create))

    adopted = await launch()

    assert adopted.modal_object_id == original.modal_object_id
    assert adopted.code_server_password == original.code_server_password == "original"
    assert adopted.vnc_password == original.vnc_password == "old-vnc"
    assert create.await_count == int(create_race)
    assert existing.exec.aio.call_args.args[-2:] == ("CODE_SERVER_PASSWORD", VNC_PASSWORD_ENV_VAR)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "output,exit_code", [("{}", 0), ('{"CODE_SERVER_PASSWORD": ""}', 0), ("invalid", 0), ("", 1)]
)
async def test_docker_adoption_fails_if_original_credentials_cannot_be_recovered(
    monkeypatch, output, exit_code
):
    manager, captured, _ = _docker_manager(monkeypatch)
    process = SimpleNamespace(
        stdout=SimpleNamespace(read=SimpleNamespace(aio=AsyncMock(return_value=output))),
        wait=SimpleNamespace(aio=AsyncMock(return_value=exit_code)),
    )
    existing = SimpleNamespace(
        object_id="modal-existing",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value=docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000")
            )
        ),
        exec=SimpleNamespace(aio=AsyncMock(return_value=process)),
    )
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=existing)),
    )

    with pytest.raises(RuntimeError, match="Could not recover adopted sandbox access credentials"):
        await manager.create_sandbox(_docker_config(code_server_enabled=True))

    assert "kwargs" not in captured
    manager._resolve_and_setup_tunnels.assert_not_awaited()


@pytest.mark.asyncio
async def test_docker_launch_refuses_a_same_named_allocation_it_does_not_own(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    foreign = SimpleNamespace(
        object_id="modal-foreign",
        get_tags=AsyncMock(return_value={"openinspect_kind": "session"}),
    )
    foreign.get_tags.aio = foreign.get_tags
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=foreign)),
    )

    with pytest.raises(RuntimeError, match="ownership mismatch"):
        await manager.create_sandbox(_docker_config())

    assert "kwargs" not in captured


@pytest.mark.asyncio
async def test_docker_launch_retires_the_prior_generation_only_when_owned(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    prior_tags = docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999")
    prior = SimpleNamespace(
        object_id="modal-prior",
        get_tags=AsyncMock(return_value=prior_tags),
        terminate=AsyncMock(),
    )
    prior.get_tags.aio = prior.get_tags
    prior.terminate.aio = prior.terminate
    prior_name = docker_allocation_name("session-1", "sandbox-acme-repo-1699999999999")

    async def from_name(_app, name):
        if name == prior_name:
            return prior
        _not_found()

    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    await manager.create_sandbox(
        _docker_config(retire_sandbox_id="sandbox-acme-repo-1699999999999")
    )

    prior.terminate.assert_awaited_once_with(wait=True)
    assert captured["kwargs"]["name"] == docker_allocation_name(
        "session-1", "sandbox-acme-repo-1700000000000"
    )

    # A prior allocation with foreign tags is left alone.
    prior.terminate.reset_mock()
    prior.get_tags = AsyncMock(return_value={"openinspect_kind": "other"})
    prior.get_tags.aio = prior.get_tags
    await manager.create_sandbox(
        _docker_config(retire_sandbox_id="sandbox-acme-repo-1699999999999")
    )
    prior.terminate.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("termination_fails", [False, True])
async def test_docker_successor_waits_for_confirmed_predecessor_retirement(
    monkeypatch, termination_fails
):
    manager, captured, _ = _docker_manager(monkeypatch)
    termination_requested = asyncio.Event()
    termination_finished = asyncio.Event()

    async def terminate(*, wait=False):
        termination_requested.set()
        if wait:
            await termination_finished.wait()
        if termination_fails:
            raise RuntimeError("termination unconfirmed")

    prior = SimpleNamespace(
        object_id="modal-prior",
        get_tags=SimpleNamespace(
            aio=AsyncMock(return_value=docker_allocation_tags("session-1", "sandbox-prior"))
        ),
        terminate=SimpleNamespace(aio=terminate),
    )
    from modal.exception import NotFoundError

    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=[prior, NotFoundError("no successor")])),
    )
    launch = asyncio.create_task(
        manager.create_sandbox(_docker_config(retire_sandbox_id="sandbox-prior"))
    )
    try:
        await asyncio.wait_for(termination_requested.wait(), timeout=1)
        assert not launch.done()
        assert "kwargs" not in captured

        termination_finished.set()
        if termination_fails:
            with pytest.raises(RuntimeError, match="termination unconfirmed"):
                await launch
            assert "kwargs" not in captured
        else:
            await launch
            assert "kwargs" in captured
    finally:
        launch.cancel()
        await asyncio.gather(launch, return_exceptions=True)
