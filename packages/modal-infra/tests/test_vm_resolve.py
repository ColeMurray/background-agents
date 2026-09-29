"""Generation-checked, lookup-only VM recovery API."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from modal.exception import AlreadyExistsError, NotFoundError

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
)
from src import web_api
from src.sandbox import manager as manager_module
from src.sandbox.launch_policy import docker_allocation_name, docker_allocation_tags
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls

SESSION = "session-1"
GENERATION = "generation-1"
RESOLVE_REQUEST = {"session_id": SESSION, "sandbox_id": GENERATION}


def _tags(launch="1-111-9000-9001-9002", ports="3000-3001"):
    return {
        **docker_allocation_tags(SESSION, GENERATION),
        "openinspect_vm_launch": launch,
        "openinspect_vm_ports": ports,
    }


async def _call(endpoint, request, authorization="Bearer test"):
    return await endpoint.get_raw_f()(
        request,
        authorization=authorization,
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


def _sandbox(tags, env=None):
    async def execute(*args, **kwargs):
        keys = args[4:]
        output = json.dumps({key: (env or {}).get(key) for key in keys})
        return SimpleNamespace(
            stdout=SimpleNamespace(read=SimpleNamespace(aio=AsyncMock(return_value=output))),
            wait=SimpleNamespace(aio=AsyncMock(return_value=0)),
        )

    return SimpleNamespace(
        object_id="sb-real-id",
        get_tags=SimpleNamespace(aio=AsyncMock(return_value=tags)),
        exec=SimpleNamespace(aio=AsyncMock(side_effect=execute)),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )


@pytest.mark.asyncio
async def test_resolve_returns_owned_vm_id_access_and_tunnels_without_mutation(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    env = {
        "CODE_SERVER_PASSWORD": "original-code-password",
        VNC_PASSWORD_ENV_VAR: "original-vnc-password",
        CODE_SERVER_PORT_ENV_VAR: "9000",
        NOVNC_PORT_ENV_VAR: "9001",
        TTYD_PROXY_PORT_ENV_VAR: "9002",
        EXPECTED_TUNNEL_PORTS_ENV_VAR: "3000,3001",
        "TERMINAL_ENABLED": "true",
    }
    sandbox = _sandbox(_tags(), env)
    from_name = AsyncMock(return_value=sandbox)
    create = AsyncMock(side_effect=AssertionError("resolve must not create"))
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_name", SimpleNamespace(aio=from_name))
    monkeypatch.setattr(manager_module.modal.Sandbox, "create", SimpleNamespace(aio=create))
    tunnels = AsyncMock(
        return_value=TunnelUrls(
            "https://code.example",
            "https://vnc.example",
            "https://terminal.example",
            {3000: "https://app.example", 3001: "https://other.example"},
        )
    )
    monkeypatch.setattr(SandboxTunnels, "resolve", tunnels)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result == {
        "success": True,
        "data": {
            "sandbox_id": GENERATION,
            "modal_object_id": "sb-real-id",
            "code_server_url": "https://code.example",
            "code_server_password": "original-code-password",
            "vnc_url": "https://vnc.example",
            "vnc_password": "original-vnc-password",
            "ttyd_url": "https://terminal.example",
            "tunnel_urls": {3000: "https://app.example", 3001: "https://other.example"},
            "sandbox_backend": "modal-vm",
        },
    }
    from_name.assert_awaited_once_with("open-inspect", docker_allocation_name(SESSION))
    sandbox.get_tags.aio.assert_awaited_once_with()
    sandbox.exec.aio.assert_awaited_once()
    sandbox.terminate.aio.assert_not_awaited()
    create.assert_not_awaited()
    tunnels.assert_awaited_once_with(sandbox, GENERATION, write_env_file=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_port", [9000, 9001, 9002, 3001])
async def test_resolve_retries_when_enabled_tunnel_is_missing(monkeypatch, missing_port):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox(
        _tags(),
        {
            "CODE_SERVER_PASSWORD": "original-code-password",
            VNC_PASSWORD_ENV_VAR: "original-vnc-password",
            CODE_SERVER_PORT_ENV_VAR: "9000",
            NOVNC_PORT_ENV_VAR: "9001",
            TTYD_PROXY_PORT_ENV_VAR: "9002",
            EXPECTED_TUNNEL_PORTS_ENV_VAR: "3000,3001",
            "TERMINAL_ENABLED": "true",
        },
    )
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    create = AsyncMock(side_effect=AssertionError("resolve must not create"))
    monkeypatch.setattr(manager_module.modal.Sandbox, "create", SimpleNamespace(aio=create))
    monkeypatch.setattr(
        SandboxTunnels,
        "_resolve_tunnels",
        AsyncMock(
            return_value={
                port: f"https://port-{port}.example"
                for port in [9000, 9001, 9002, 3000, 3001]
                if port != missing_port
            }
        ),
    )
    write_env = AsyncMock(side_effect=AssertionError("resolve must not write"))
    monkeypatch.setattr(SandboxTunnels, "_write_tunnel_env_file", write_env)

    with pytest.raises(HTTPException) as exc:
        await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert (exc.value.status_code, exc.value.detail) == (409, "race_pending")
    create.assert_not_awaited()
    sandbox.terminate.aio.assert_not_awaited()
    write_env.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_disabled_access_does_not_return_credentials(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox(_tags("1-000-8080-6080-7680", "none"))
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    tunnels = AsyncMock(return_value=TunnelUrls())
    monkeypatch.setattr(SandboxTunnels, "resolve", tunnels)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result["data"]["code_server_password"] is None
    assert result["data"]["vnc_password"] is None
    tunnels.assert_awaited_once_with(sandbox, GENERATION, write_env_file=False)


@pytest.mark.asyncio
async def test_resolve_extra_tunnels_does_not_write_into_vm(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox(
        _tags("1-000-8080-6080-7680", "3000"),
        {EXPECTED_TUNNEL_PORTS_ENV_VAR: "9999"},
    )
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    monkeypatch.setattr(
        SandboxTunnels,
        "_resolve_tunnels",
        AsyncMock(return_value={3000: "https://app.example"}),
    )
    write_env = AsyncMock(side_effect=AssertionError("resolve must not write"))
    monkeypatch.setattr(SandboxTunnels, "_write_tunnel_env_file", write_env)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result["data"]["tunnel_urls"] == {3000: "https://app.example"}
    write_env.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_legacy_user_password_does_not_enable_access(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox(
        docker_allocation_tags(SESSION, GENERATION),
        {
            "CODE_SERVER_PASSWORD": "user-repo-secret",
            VNC_PASSWORD_ENV_VAR: "user-vnc-secret",
            CODE_SERVER_PORT_ENV_VAR: "9000",
            EXPECTED_TUNNEL_PORTS_ENV_VAR: "3000",
            "TERMINAL_ENABLED": "true",
        },
    )
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    tunnels = AsyncMock(side_effect=AssertionError("legacy resolve must not inspect tunnels"))
    monkeypatch.setattr(SandboxTunnels, "resolve", tunnels)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result["data"] == {
        "sandbox_id": GENERATION,
        "modal_object_id": "sb-real-id",
        "code_server_url": None,
        "code_server_password": None,
        "vnc_url": None,
        "vnc_password": None,
        "ttyd_url": None,
        "tunnel_urls": None,
        "sandbox_backend": "modal-vm",
    }
    sandbox.exec.aio.assert_not_awaited()
    sandbox.terminate.aio.assert_not_awaited()
    tunnels.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_versioned_flags_ignore_user_password_when_service_disabled(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox(
        _tags("1-010-9000-9001-9002", "none"),
        {"CODE_SERVER_PASSWORD": "user-repo-secret", VNC_PASSWORD_ENV_VAR: "vnc-password"},
    )
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    tunnels = AsyncMock(return_value=TunnelUrls(vnc_url="https://vnc.example"))
    monkeypatch.setattr(SandboxTunnels, "resolve", tunnels)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result["data"]["code_server_password"] is None
    assert result["data"]["code_server_url"] is None
    assert result["data"]["vnc_password"] == "vnc-password"
    assert sandbox.exec.aio.call_args.args[-1:] == (VNC_PASSWORD_ENV_VAR,)
    tunnels.assert_awaited_once_with(sandbox, GENERATION, write_env_file=False)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "launch,ports",
    [
        ("2-111-9000-9001-9002", "3000"),
        ("1-111-9000-9001-9002", None),
        ("1-111-0-9001-9002", "3000"),
        ("1-11x-9000-9001-9002", "3000"),
        ("1-111-9000-9001-9002", "65536"),
    ],
)
async def test_resolve_unknown_or_incomplete_metadata_never_falls_back_to_env(
    monkeypatch, launch, ports
):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    tags = _tags(launch, ports)
    if ports is None:
        del tags["openinspect_vm_ports"]
    sandbox = _sandbox(tags, {"CODE_SERVER_PASSWORD": "user-repo-secret"})
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )
    tunnels = AsyncMock(side_effect=AssertionError("invalid metadata must not inspect tunnels"))
    monkeypatch.setattr(SandboxTunnels, "resolve", tunnels)

    result = await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert result["data"]["modal_object_id"] == "sb-real-id"
    assert result["data"]["code_server_password"] is None
    assert result["data"]["tunnel_urls"] is None
    sandbox.exec.aio.assert_not_awaited()
    tunnels.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("allocation", "status", "detail"),
    [
        (None, 409, "not_visible"),
        ("foreign", 409, "other_generation"),
    ],
)
async def test_resolve_reports_typed_absence_or_foreign_generation(
    monkeypatch, allocation, status, detail
):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    lookup = (
        AsyncMock(side_effect=NotFoundError("not visible"))
        if allocation is None
        else AsyncMock(return_value=_sandbox(docker_allocation_tags(SESSION, "other")))
    )
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_name", SimpleNamespace(aio=lookup))
    create = AsyncMock()
    monkeypatch.setattr(manager_module.modal.Sandbox, "create", SimpleNamespace(aio=create))

    with pytest.raises(HTTPException) as exc:
        await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert (exc.value.status_code, exc.value.detail) == (status, detail)
    create.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_rejects_unexpected_allocation_tags(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    sandbox = _sandbox({**_tags(), "unexpected": "tag"})
    monkeypatch.setattr(
        manager_module.modal.Sandbox,
        "from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )

    with pytest.raises(HTTPException) as exc:
        await _call(web_api.api_resolve_vm_sandbox, RESOLVE_REQUEST)

    assert (exc.value.status_code, exc.value.detail) == (409, "other_generation")
    sandbox.exec.aio.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_authenticates_before_lookup_or_validation(monkeypatch):
    lookup = AsyncMock()
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_name", SimpleNamespace(aio=lookup))
    monkeypatch.setattr(
        web_api,
        "require_auth",
        lambda _token: (_ for _ in ()).throw(HTTPException(status_code=401)),
    )

    with pytest.raises(HTTPException) as exc:
        await _call(web_api.api_resolve_vm_sandbox, {"sandbox_auth_token": "secret"}, None)

    assert exc.value.status_code == 401
    lookup.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra", ["sandbox_auth_token", "user_env_vars", "retire_sandbox_id", "control_plane_url"]
)
async def test_resolve_rejects_secret_or_mutating_request_fields(monkeypatch, extra):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    lookup = AsyncMock()
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_name", SimpleNamespace(aio=lookup))

    with pytest.raises(HTTPException) as exc:
        await _call(web_api.api_resolve_vm_sandbox, {**RESOLVE_REQUEST, extra: "forbidden"})

    assert exc.value.status_code == 400
    lookup.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["session_id", "sandbox_id"])
async def test_resolve_requires_both_identity_fields(monkeypatch, field):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)

    with pytest.raises(HTTPException) as exc:
        await _call(
            web_api.api_resolve_vm_sandbox, {k: v for k, v in RESOLVE_REQUEST.items() if k != field}
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == f"{field} is required"


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["api_create_sandbox", "api_restore_sandbox"])
@pytest.mark.parametrize(
    ("case", "detail"),
    [("foreign", "other_generation"), ("expired", "window_closed"), ("race", "race_pending")],
)
async def test_vm_launch_reports_typed_outcomes(monkeypatch, endpoint, case, detail):
    monkeypatch.setattr(web_api, "require_auth", lambda _token: None)
    monkeypatch.setattr(web_api, "require_valid_control_plane_url", lambda _url: None)
    monkeypatch.setattr("src.images.base.docker_image", object())
    monkeypatch.setattr(manager_module.modal.Image, "from_id", lambda _id: object())
    lookup = (
        AsyncMock(return_value=_sandbox(docker_allocation_tags(SESSION, "other")))
        if case == "foreign"
        else AsyncMock(side_effect=NotFoundError("not visible"))
    )
    create = AsyncMock(side_effect=AlreadyExistsError("winner not visible"))
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_name", SimpleNamespace(aio=lookup))
    monkeypatch.setattr(manager_module.modal.Sandbox, "create", SimpleNamespace(aio=create))
    request = {
        "sandbox_id": GENERATION,
        "control_plane_url": "https://control.example",
        "sandbox_auth_token": "secret",
        "sandbox_backend": "modal-vm",
        "launch_deadline_at_ms": 1 if case == "expired" else 9999999999999,
    }
    if endpoint == "api_create_sandbox":
        request["session_id"] = SESSION
    else:
        request["session_config"] = {"session_id": SESSION}
        request["snapshot_image_id"] = "im-snapshot"

    with pytest.raises(HTTPException) as exc:
        await _call(getattr(web_api, endpoint), request)

    assert (exc.value.status_code, exc.value.detail) == (409, detail)
    assert create.await_count == (1 if case == "race" else 0)
    assert lookup.await_count == (2 if case == "race" else 1)
