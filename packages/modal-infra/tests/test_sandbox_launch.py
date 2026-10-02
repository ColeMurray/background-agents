"""Behavior matrix for shared fresh, repository-image, and snapshot launches."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from modal.exception import NotFoundError

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    DOCKER_ENABLED_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
    VNC_PASSWORD_ENV_VAR,
)
from sandbox_runtime.types import SandboxStatus, SessionConfig
from src.sandbox.launch import SandboxLauncher
from src.sandbox.launch_policy import (
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
from src.sandbox.vm_recovery import VMServiceLaunch
from tests.modal_sdk_contract import sandbox_create_request
from tests.sandbox_launch_helpers import (
    DOCKER_SETTINGS,
    _docker_config,
    _docker_manager,
    _fake_create,
    _not_found,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
@pytest.mark.parametrize(
    "resources, expected_cpu, expected_memory, timeout_seconds",
    [
        ({}, None, None, 30),
        ({"cpuCores": 0.5}, 0.5, None, 300),
        ({"memoryMib": 2048}, None, 2048, 1800),
        ({"cpuCores": 1.5, "memoryMib": 3072}, 1.5, 3072, 4321),
    ],
    ids=["defaults", "cpu-only", "memory-only", "cpu-and-memory"],
)
async def test_launch_matrix_preserves_common_and_source_specific_behavior(
    monkeypatch,
    image_source,
    resources,
    expected_cpu,
    expected_memory,
    timeout_seconds,
):
    captured: dict = {}
    base_image = object()
    images = {
        "repo-image-1": object(),
        "snapshot-image-1": object(),
    }
    monkeypatch.setattr("src.sandbox.launch.base_image", base_image)
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", images.__getitem__)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_create(captured))
    monkeypatch.setattr(
        SandboxLauncher, "_generate_code_server_password", staticmethod(lambda: "code-password")
    )
    monkeypatch.setattr(SandboxLauncher, "_generate_vnc_password", staticmethod(lambda: "vnc-pass"))

    manager = SandboxManager()
    settings = {
        "codeServerPort": 9000,
        "vncPort": 9001,
        "terminalPort": 9002,
        "terminalEnabled": True,
        "tunnelPorts": [3000],
        **resources,
    }
    common = {
        "sandbox_id": "sandbox-1",
        "control_plane_url": "https://control.example",
        "sandbox_auth_token": "sandbox-token",
        "clone_host": "github.example",
        "clone_username": "provided-user",
        "timeout_seconds": timeout_seconds,
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
    sandbox_create_request(*captured["command"], **kwargs)
    env = kwargs["env"]
    assert captured["command"] == ("python", "-m", "sandbox_runtime.entrypoint")
    assert kwargs["image"] is expected_image
    assert kwargs["timeout"] == timeout_seconds
    assert kwargs.get("cpu") == expected_cpu
    assert kwargs.get("memory") == expected_memory
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
    assert "GITHUB_APP_PRIVATE_KEY" not in env
    assert env["VCS_HOST"] == "github.example"
    assert env["VCS_CLONE_USERNAME"] == "provided-user"
    assert "VCS_CLONE_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env
    assert "GITHUB_APP_TOKEN" not in env

    if image_source == "repository":
        assert env["FROM_REPO_IMAGE"] == "true"
        assert env["REPO_IMAGE_SHA"] == "abc123"
    else:
        assert "FROM_REPO_IMAGE" not in env

    if image_source == "snapshot":
        assert env["RESTORED_FROM_SNAPSHOT"] == "true"
        assert '"future_field": {"preserved": true}' in env["SESSION_CONFIG"]
    else:
        assert "RESTORED_FROM_SNAPSHOT" not in env
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
    handle.modal_sandbox.tunnels.assert_called_once_with()
    handle.modal_sandbox.filesystem.write_text.aio.assert_awaited_once_with(
        f"{TUNNEL_ENV_SANDBOX_ID_KEY}=sandbox-1\nTUNNEL_3000=https://app.example\n",
        TUNNEL_ENV_FILE_PATH,
    )


@pytest.mark.asyncio
async def test_repository_image_create_validates_repo_before_image_lookup(monkeypatch):
    from_id = Mock(side_effect=AssertionError("image lookup should not run"))
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", from_id)

    with pytest.raises(ValueError, match="repo_owner and repo_name must be provided together"):
        await SandboxManager().create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name=None,
                repo_image_id="repo-image-1",
            )
        )

    from_id.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["repository", "snapshot"])
@pytest.mark.parametrize("failure_stage", ["lookup", "create"])
@pytest.mark.parametrize("missing", [False, True])
async def test_launch_preserves_image_error_classification(
    monkeypatch, image_source, failure_stage, missing
):
    error = NotFoundError("missing image") if missing else RuntimeError("transient failure")
    from_id = Mock(
        return_value=object(),
        side_effect=error if failure_stage == "lookup" else None,
    )
    create = AsyncMock(side_effect=error)
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", SimpleNamespace(aio=create))
    expected_error = (
        RepositoryImageUnavailableError if image_source == "repository" and missing else type(error)
    )

    with pytest.raises(expected_error) as raised:
        if image_source == "snapshot":
            await SandboxManager().restore_from_snapshot(
                clone_host="github.com",
                clone_username="x-access-token",
                snapshot_image_id="image-1",
                session_config={"repo_owner": "acme", "repo_name": "repo"},
            )
        else:
            await SandboxManager().create_sandbox(
                SandboxConfig(
                    clone_host="github.com",
                    clone_username="x-access-token",
                    repo_owner="acme",
                    repo_name="repo",
                    repo_image_id="image-1",
                )
            )

    if expected_error is RepositoryImageUnavailableError:
        assert raised.value.__cause__ is error
    else:
        assert raised.value is error
    from_id.assert_called_once_with("image-1")
    if failure_stage == "lookup":
        create.assert_not_awaited()
    else:
        # A spawn error must not silently fall back to a different image or retry.
        create.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", [False, True])
async def test_base_image_spawn_errors_propagate_without_retry(monkeypatch, missing):
    error = NotFoundError("missing image") if missing else RuntimeError("transient failure")
    create = AsyncMock(side_effect=error)
    from_id = Mock()
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", SimpleNamespace(aio=create))

    with pytest.raises(type(error)) as raised:
        await SandboxManager().create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner=None,
                repo_name=None,
            )
        )

    assert raised.value is error
    create.assert_awaited_once()
    from_id.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
@pytest.mark.parametrize("failure", ["partial", "unavailable", "write"])
async def test_launch_returns_handle_despite_tunnel_failures(monkeypatch, image_source, failure):
    write_text = AsyncMock(side_effect=OSError("write failed") if failure == "write" else None)
    sandbox = SimpleNamespace(
        object_id="modal-object-1",
        tunnels=Mock(
            side_effect=(
                [RuntimeError("unavailable")] * 3
                if failure == "unavailable"
                else [
                    {9000: SimpleNamespace(url="https://code.example")},
                    RuntimeError("not ready"),
                    {3000: SimpleNamespace(url="https://app.example")},
                ]
            )
        ),
        filesystem=SimpleNamespace(write_text=SimpleNamespace(aio=write_text)),
    )
    create = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", SimpleNamespace(aio=create))
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _: object())
    sleep = AsyncMock()
    monkeypatch.setattr("src.sandbox.tunnels.asyncio.sleep", sleep)
    common = {
        "sandbox_id": "sandbox-partial",
        "code_server_enabled": True,
        "settings": {"codeServerPort": 9000, "tunnelPorts": [3000, 3001]},
    }
    manager = SandboxManager()

    if image_source == "snapshot":
        handle = await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="image-1",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            **common,
        )
    else:
        handle = await manager.create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
                repo_image_id="image-1" if image_source == "repository" else None,
                **common,
            )
        )

    assert handle.status is SandboxStatus.WARMING
    assert handle.modal_sandbox is sandbox
    assert handle.modal_object_id == "modal-object-1"
    assert handle.code_server_password == create.call_args.kwargs["env"]["CODE_SERVER_PASSWORD"]
    assert create.call_args.kwargs["encrypted_ports"] == [9000, 3000, 3001]
    assert sandbox.tunnels.call_count == 3
    assert [call.args for call in sleep.await_args_list] == [(1.0,), (2.0,)]
    create.assert_awaited_once()
    if failure == "unavailable":
        assert handle.code_server_url is None
        assert handle.tunnel_urls is None
        write_text.assert_not_awaited()
    else:
        assert handle.code_server_url == "https://code.example"
        assert handle.tunnel_urls == {3000: "https://app.example"}
        write_text.assert_awaited_once_with(
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=sandbox-partial\nTUNNEL_3000=https://app.example\n",
            TUNNEL_ENV_FILE_PATH,
        )


@pytest.mark.asyncio
async def test_repository_image_not_found_is_reported_explicitly(monkeypatch, fake_llm_secret):
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _image_id: object())

    async def create_aio(*_args, **_kwargs):
        fake_llm_secret[0].hydrate.aio.assert_awaited_once_with()
        raise NotFoundError("image not found")

    create = SimpleNamespace(aio=AsyncMock(side_effect=create_aio))
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", create)

    with pytest.raises(RepositoryImageUnavailableError) as exc_info:
        await SandboxManager().create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
                repo_image_id="image-1",
            )
        )

    assert isinstance(exc_info.value.__cause__, NotFoundError)
    create.aio.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_secret_does_not_mark_repository_image_unavailable(monkeypatch):
    create = SimpleNamespace(aio=AsyncMock())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", create)

    def missing_secret(_name, **_kwargs):
        secret = Mock()
        secret.hydrate.aio = AsyncMock(side_effect=NotFoundError("secret not found"))
        return secret

    monkeypatch.setattr("src.sandbox.launch.modal.Secret.from_name", missing_secret)

    with pytest.raises(NotFoundError, match="secret not found"):
        await SandboxManager().create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
                repo_image_id="repo-image-1",
            )
        )

    create.aio.assert_not_awaited()


@pytest.mark.asyncio
async def test_base_image_not_found_is_not_classified_as_repository_image(monkeypatch):
    create = SimpleNamespace(aio=AsyncMock(side_effect=NotFoundError("base image not found")))
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", create)

    with pytest.raises(NotFoundError, match="base image not found"):
        await SandboxManager().create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
            )
        )

    create.aio.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "repository", "snapshot"])
@pytest.mark.parametrize(
    "settings, expected_cpu, expected_memory, timeout_seconds",
    [
        (None, 2, 4096, 30),
        (DOCKER_SETTINGS, 2, 4096, 4321),
        ({"cpuCores": 0.5, "memoryMib": 2048}, 0.5, 2048, 600),
    ],
    ids=["defaults", "integer-cpu", "fractional-cpu"],
)
async def test_docker_launch_selects_vm_runtime_and_named_allocation(
    monkeypatch, image_source, settings, expected_cpu, expected_memory, timeout_seconds
):
    manager, captured, docker_image = _docker_manager(monkeypatch)
    artifact = object()
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _id: artifact)
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=_not_found)),
    )

    if image_source == "snapshot":
        handle = await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="snapshot-1",
            session_config={"session_id": "session-1", "repo_owner": "acme", "repo_name": "repo"},
            sandbox_id="sandbox-acme-repo-1700000000000",
            control_plane_url="https://control.example",
            sandbox_auth_token="token",
            user_env_vars={DOCKER_ENABLED_ENV_VAR: "false"},
            settings=settings,
            timeout_seconds=timeout_seconds,
            sandbox_backend="modal-vm",
        )
    else:
        handle = await manager.create_sandbox(
            _docker_config(
                repo_image_id="repo-image-1" if image_source == "repository" else None,
                settings=settings,
                timeout_seconds=timeout_seconds,
            )
        )

    kwargs = captured["kwargs"]
    sandbox_create_request(*captured["command"], **kwargs)
    assert kwargs["image"] is (docker_image if image_source == "base" else artifact)
    assert kwargs["experimental_options"] == {"vm_runtime": True}
    assert kwargs["cpu"] == (expected_cpu, expected_cpu)
    assert kwargs["memory"] == expected_memory
    assert kwargs["timeout"] == timeout_seconds
    assert kwargs["name"] == docker_allocation_name("session-1")
    assert kwargs["tags"] == {
        **docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000"),
        **VMServiceLaunch(False, False, False, 8080, 6080, 7680, []).tags(),
        "openinspect_generation_created_at_ms": "1700000000000",
    }
    assert kwargs["env"][DOCKER_ENABLED_ENV_VAR] == "true"
    assert handle.sandbox_backend == "modal-vm"


@pytest.mark.asyncio
async def test_docker_launch_does_not_allow_user_env_to_spoof_resolved_access(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=_not_found)),
    )
    await manager.create_sandbox(
        _docker_config(
            user_env_vars={
                "CODE_SERVER_PASSWORD": "spoofed",
                VNC_PASSWORD_ENV_VAR: "spoofed",
                CODE_SERVER_PORT_ENV_VAR: "9000",
                EXPECTED_TUNNEL_PORTS_ENV_VAR: "3000",
            }
        )
    )

    for key in (
        "CODE_SERVER_PASSWORD",
        VNC_PASSWORD_ENV_VAR,
        CODE_SERVER_PORT_ENV_VAR,
        EXPECTED_TUNNEL_PORTS_ENV_VAR,
    ):
        assert key not in captured["kwargs"]["env"]
    assert captured["kwargs"]["tags"]["openinspect_vm_launch"] == "1-000-8080-6080-7680"
    assert captured["kwargs"]["tags"]["openinspect_vm_ports"] == "none"


@pytest.mark.asyncio
async def test_docker_launch_tags_record_effective_enabled_services_and_ports(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=_not_found)),
    )

    await manager.create_sandbox(
        _docker_config(
            code_server_enabled=True,
            vnc_enabled=True,
            settings={
                **DOCKER_SETTINGS,
                "terminalEnabled": True,
                "codeServerPort": 9000,
                "vncPort": 9001,
                "terminalPort": 9002,
                "tunnelPorts": [3000, 3001],
            },
        )
    )

    assert captured["kwargs"]["tags"]["openinspect_vm_launch"] == "1-111-9000-9001-9002"
    assert captured["kwargs"]["tags"]["openinspect_vm_ports"] == "3000-3001"
    assert captured["kwargs"]["encrypted_ports"] == [9000, 9001, 9002, 3000, 3001]


@pytest.mark.asyncio
async def test_docker_launch_without_a_provisioned_image_never_uses_the_default(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr("src.images.base.docker_image", None)

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
@pytest.mark.parametrize("restore", [False, True], ids=["create", "restore"])
@pytest.mark.parametrize(
    "ports, expected",
    [
        ([True, False], []),
        ([True, False, 0, -1, 65536, "3000", 3.5, None, 1, 3000, 65535], [1, 3000, 65535]),
        ([True] * 10 + [3000], [3000]),
    ],
    ids=["booleans-only", "mixed-with-boundary-ports", "booleans-do-not-consume-limit"],
)
async def test_launch_rejects_boolean_tunnel_ports(monkeypatch, restore, ports, expected):
    """Invalid extras never reach Modal or the runtime's expected-port list."""
    urls = {port: f"https://port-{port}.example" for port in expected}
    sandbox = SimpleNamespace(
        object_id="modal-ports",
        tunnels=Mock(return_value={port: SimpleNamespace(url=url) for port, url in urls.items()}),
        filesystem=SimpleNamespace(write_text=SimpleNamespace(aio=AsyncMock())),
    )
    create = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", SimpleNamespace(aio=create))
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _: object())
    manager = SandboxManager()
    settings = {"tunnelPorts": ports}

    if restore:
        handle = await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="image-1",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            settings=settings,
        )
    else:
        handle = await manager.create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
                settings=settings,
            )
        )

    kwargs = create.call_args.kwargs
    sandbox_create_request(*create.call_args.args, **kwargs)
    assert kwargs.get("encrypted_ports", []) == expected
    assert all(type(port) is int for port in kwargs.get("encrypted_ports", []))
    assert kwargs["env"].get(EXPECTED_TUNNEL_PORTS_ENV_VAR) == (
        ",".join(str(port) for port in expected) if expected else None
    )
    assert handle.tunnel_urls == (urls or None)
    if not expected:
        sandbox.tunnels.assert_not_called()
