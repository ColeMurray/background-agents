"""Tests for Modal create-sandbox API request assembly."""

import asyncio
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock

import pytest
from fastapi import HTTPException

from sandbox_runtime.types import SandboxStatus
from src import web_api
from src.sandbox import manager as manager_module
from src.sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "require_valid_control_plane_url", lambda _url: None)


def _patch_manager(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict,
    *,
    vnc_url: str | None = None,
    vnc_password: str | None = None,
) -> None:
    class FakeManager:
        async def create_sandbox(self, config):
            captured["config"] = config
            return SimpleNamespace(
                sandbox_id="sandbox-123",
                modal_object_id="obj-123",
                status=SandboxStatus.WARMING,
                created_at=123.0,
                code_server_url=None,
                code_server_password=None,
                vnc_url=vnc_url,
                vnc_password=vnc_password,
                ttyd_url=None,
                tunnel_urls=None,
            )

    monkeypatch.setattr(manager_module, "SandboxManager", FakeManager)


def _patch_restore_manager(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict,
    *,
    vnc_url: str | None = None,
    vnc_password: str | None = None,
) -> None:
    class FakeManager:
        async def restore_from_snapshot(self, **kwargs):
            captured["restore"] = kwargs
            return SimpleNamespace(
                sandbox_id="sandbox-123",
                modal_object_id="obj-123",
                status=SandboxStatus.WARMING,
                code_server_url=None,
                code_server_password=None,
                vnc_url=vnc_url,
                vnc_password=vnc_password,
                ttyd_url=None,
                tunnel_urls=None,
            )

    monkeypatch.setattr(manager_module, "SandboxManager", FakeManager)


async def _call_create_sandbox(request: dict, **headers) -> dict:
    request_headers = {
        "authorization": "Bearer test",
        "x_trace_id": None,
        "x_request_id": None,
        "x_session_id": None,
        "x_sandbox_id": None,
        **headers,
    }
    return await web_api.api_create_sandbox.get_raw_f()(
        request,
        **request_headers,
    )


async def _call_restore_sandbox(request: dict, **headers) -> dict:
    request_headers = {
        "authorization": "Bearer test",
        "x_trace_id": None,
        "x_request_id": None,
        "x_session_id": None,
        "x_sandbox_id": None,
        **headers,
    }
    return await web_api.api_restore_sandbox.get_raw_f()(
        request,
        **request_headers,
    )


CREATE_REQUEST = {
    "session_id": "sess-1",
    "control_plane_url": "https://control-plane.example",
    "sandbox_auth_token": "sandbox-token",
}

RESTORE_REQUEST = {
    "snapshot_image_id": "img-abc",
    "session_config": {"session_id": "sess-1"},
    "control_plane_url": "https://control-plane.example",
    "sandbox_auth_token": "sandbox-token",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("call", "payload", "field"),
    [
        (_call_create_sandbox, CREATE_REQUEST, "code_server_enabled"),
        (_call_create_sandbox, CREATE_REQUEST, "vnc_enabled"),
        (_call_create_sandbox, CREATE_REQUEST, "agent_slack_notify_enabled"),
        (_call_restore_sandbox, RESTORE_REQUEST, "code_server_enabled"),
        (_call_restore_sandbox, RESTORE_REQUEST, "vnc_enabled"),
        (_call_restore_sandbox, RESTORE_REQUEST, "agent_slack_notify_enabled"),
    ],
)
async def test_sandbox_requests_reject_string_booleans(monkeypatch, call, payload, field):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await call({**payload, field: "false"})

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == f"{field} must be a boolean"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("call", "payload"),
    [
        (_call_create_sandbox, {**CREATE_REQUEST, "user_env_vars": {"PORT": 3000}}),
        (_call_restore_sandbox, {**RESTORE_REQUEST, "user_env_vars": {"PORT": 3000}}),
        (_call_restore_sandbox, {**RESTORE_REQUEST, "session_config": []}),
    ],
)
async def test_sandbox_requests_reject_invalid_typed_fields(monkeypatch, call, payload):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await call(payload)

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("call", "payload", "field"),
    [
        (
            _call_create_sandbox,
            {key: value for key, value in CREATE_REQUEST.items() if key != "control_plane_url"},
            "control_plane_url",
        ),
        (_call_create_sandbox, {**CREATE_REQUEST, "control_plane_url": ""}, "control_plane_url"),
        (
            _call_create_sandbox,
            {key: value for key, value in CREATE_REQUEST.items() if key != "sandbox_auth_token"},
            "sandbox_auth_token",
        ),
        (_call_create_sandbox, {**CREATE_REQUEST, "sandbox_auth_token": ""}, "sandbox_auth_token"),
        (
            _call_restore_sandbox,
            {key: value for key, value in RESTORE_REQUEST.items() if key != "control_plane_url"},
            "control_plane_url",
        ),
        (_call_restore_sandbox, {**RESTORE_REQUEST, "control_plane_url": ""}, "control_plane_url"),
        (
            _call_restore_sandbox,
            {key: value for key, value in RESTORE_REQUEST.items() if key != "sandbox_auth_token"},
            "sandbox_auth_token",
        ),
        (
            _call_restore_sandbox,
            {**RESTORE_REQUEST, "sandbox_auth_token": ""},
            "sandbox_auth_token",
        ),
    ],
)
async def test_sandbox_requests_require_launch_credentials(monkeypatch, call, payload, field):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await call(payload)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == f"{field} is required"


@pytest.mark.asyncio
async def test_create_sandbox_passes_unknown_fields_to_session_config_helper(monkeypatch):
    captured = {}
    helper_requests = []
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)
    original_helper = web_api._session_config_from_create_request

    def capture_helper(request, **kwargs):
        helper_requests.append(request)
        return original_helper(request, **kwargs)

    monkeypatch.setattr(web_api, "_session_config_from_create_request", capture_helper)

    result = await _call_create_sandbox({**CREATE_REQUEST, "future_launch_option": True})

    assert result["success"] is True
    assert helper_requests[0]["future_launch_option"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("call", [_call_create_sandbox, _call_restore_sandbox])
async def test_sandbox_generic_failures_raise_500_and_log_request(monkeypatch, call):
    _patch_auth(monkeypatch)
    info = MagicMock()
    error = MagicMock()
    monkeypatch.setattr(web_api.log, "info", info)
    monkeypatch.setattr(web_api.log, "error", error)

    class FailingManager:
        async def create_sandbox(self, _config):
            raise RuntimeError("sensitive provider failure")

        async def restore_from_snapshot(self, **_kwargs):
            raise RuntimeError("sensitive provider failure")

    monkeypatch.setattr(manager_module, "SandboxManager", FailingManager)
    request = CREATE_REQUEST if call is _call_create_sandbox else RESTORE_REQUEST
    path = "/api_create_sandbox" if call is _call_create_sandbox else "/api_restore_sandbox"
    endpoint = path.removeprefix("/")

    with pytest.raises(HTTPException) as exc_info:
        await call(
            request,
            x_trace_id="trace-1",
            x_request_id="request-1",
            x_session_id="sess-1",
            x_sandbox_id="sandbox-1",
        )

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Internal server error"
    error.assert_called_once()
    info.assert_called_once_with(
        "modal.http_request",
        http_method="POST",
        http_path=path,
        http_status=500,
        duration_ms=ANY,
        outcome="error",
        endpoint_name=endpoint,
        trace_id="trace-1",
        request_id="request-1",
        session_id="sess-1",
        sandbox_id="sandbox-1",
    )


@pytest.mark.asyncio
async def test_endpoint_execution_logs_cancellation_as_error(monkeypatch):
    _patch_auth(monkeypatch)
    info = MagicMock()
    monkeypatch.setattr(web_api.log, "info", info)

    with pytest.raises(asyncio.CancelledError):
        async with web_api._execute_endpoint(
            endpoint_name="api_test",
            authorization="Bearer test",
            trace_id="trace-1",
            request_id="request-1",
        ):
            raise asyncio.CancelledError

    info.assert_called_once_with(
        "modal.http_request",
        http_method="POST",
        http_path="/api_test",
        http_status=499,
        duration_ms=ANY,
        outcome="error",
        endpoint_name="api_test",
        trace_id="trace-1",
        request_id="request-1",
    )


@pytest.mark.asyncio
async def test_create_sandbox_preserves_known_http_exception(monkeypatch):
    _patch_auth(monkeypatch)
    info = MagicMock()
    monkeypatch.setattr(web_api.log, "info", info)

    class RejectingManager:
        async def create_sandbox(self, _config):
            raise HTTPException(status_code=409, detail="sandbox already exists")

    monkeypatch.setattr(manager_module, "SandboxManager", RejectingManager)

    with pytest.raises(HTTPException) as exc_info:
        await _call_create_sandbox(CREATE_REQUEST)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "sandbox already exists"
    assert info.call_args.kwargs["http_status"] == 409


@pytest.mark.asyncio
async def test_create_sandbox_authenticates_before_request_validation(monkeypatch):
    calls = []

    def reject_auth(_authorization):
        calls.append("auth")
        raise HTTPException(status_code=401, detail="Unauthorized")

    monkeypatch.setattr(web_api, "require_auth", reject_auth)
    monkeypatch.setattr(
        web_api,
        "require_valid_control_plane_url",
        lambda _url: calls.append("url"),
    )

    with pytest.raises(HTTPException) as exc_info:
        await _call_create_sandbox({"vnc_enabled": "false"})

    assert exc_info.value.status_code == 401
    assert calls == ["auth"]


@pytest.mark.asyncio
async def test_create_sandbox_does_not_resolve_clone_token_for_fresh_boot(monkeypatch):
    """Fresh base-image boots authenticate via the credential helper only."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)
    monkeypatch.setattr(web_api, "resolve_clone_token", lambda: calls.append(True) or "ghs_token")

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    assert calls == []


@pytest.mark.asyncio
async def test_create_sandbox_forwards_timeout(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "timeout_seconds": 14_400,
        }
    )

    assert result["success"] is True
    assert captured["config"].timeout_seconds == 14_400


@pytest.mark.asyncio
async def test_create_sandbox_forwards_vnc_and_returns_credentials(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(
        monkeypatch,
        captured,
        vnc_url="https://vnc.example.com",
        vnc_password="vnc-password",
    )

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "vnc_enabled": True,
        }
    )

    assert captured["config"].vnc_enabled is True
    assert result["data"]["vnc_url"] == "https://vnc.example.com"
    assert result["data"]["vnc_password"] == "vnc-password"


@pytest.mark.asyncio
async def test_create_sandbox_uses_default_timeout_when_omitted(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    assert captured["config"].timeout_seconds == DEFAULT_SANDBOX_TIMEOUT_SECONDS


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout_seconds", [0, -1, 1.5, float("inf"), True, "not-a-timeout"])
async def test_create_sandbox_rejects_invalid_timeout(monkeypatch, timeout_seconds):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await _call_create_sandbox(
            {
                "session_id": "sess-1",
                "control_plane_url": "https://control-plane.example",
                "sandbox_auth_token": "sandbox-token",
                "timeout_seconds": timeout_seconds,
            }
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "timeout_seconds must be a positive integer"


@pytest.mark.asyncio
async def test_create_sandbox_does_not_resolve_clone_token_for_repo_image_boot(monkeypatch):
    """Repo-image boots authenticate via brokered credentials only."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    def resolve_clone_token() -> str:
        calls.append(True)
        return "ghs_prebuilt"

    monkeypatch.setattr(web_api, "resolve_clone_token", resolve_clone_token)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "repo_image_id": "repo-image-1",
        }
    )

    assert result["success"] is True
    assert calls == []


@pytest.mark.asyncio
async def test_create_sandbox_threads_missing_repo_fields(monkeypatch):
    """No-repository sandboxes are represented by null repo fields."""
    captured = {}

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    config = captured["config"]

    assert result["success"] is True
    assert config.repo_owner is None
    assert config.repo_name is None
    assert config.session_config.repo_owner is None
    assert config.session_config.repo_name is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "request_patch",
    [
        {"repo_owner": "acme"},
        {"repo_name": "repo"},
        {"repo_owner": "   ", "repo_name": "repo"},
    ],
)
async def test_create_sandbox_rejects_partial_repo_context(monkeypatch, request_patch):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await _call_create_sandbox(
            {
                "session_id": "sess-1",
                "control_plane_url": "https://control-plane.example",
                "sandbox_auth_token": "sandbox-token",
                **request_patch,
            }
        )

    assert getattr(exc_info.value, "status_code", None) == 400
    assert "repo_owner and repo_name must be provided together" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_restore_sandbox_without_repo_does_not_resolve_clone_token(monkeypatch):
    """No-repository snapshot restores must not mint a repository clone token."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_restore_manager(monkeypatch, captured)
    monkeypatch.setattr(web_api, "resolve_clone_token", lambda: calls.append(True) or "ghs_token")

    result = await _call_restore_sandbox(
        {
            "snapshot_image_id": "img-abc",
            "session_config": {
                "session_id": "sess-1",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
            },
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    assert calls == []
    assert captured["restore"]["clone_token"] is None


@pytest.mark.asyncio
async def test_restore_sandbox_forwards_timeout(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_restore_manager(monkeypatch, captured)

    result = await _call_restore_sandbox(
        {
            "snapshot_image_id": "img-abc",
            "session_config": {"session_id": "sess-1"},
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "timeout_seconds": 14_400,
        }
    )

    assert result["success"] is True
    assert captured["restore"]["timeout_seconds"] == 14_400


@pytest.mark.asyncio
async def test_restore_sandbox_forwards_vnc_and_returns_credentials(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_restore_manager(
        monkeypatch,
        captured,
        vnc_url="https://restored-vnc.example.com",
        vnc_password="restored-vnc-password",
    )

    result = await _call_restore_sandbox(
        {
            "snapshot_image_id": "img-abc",
            "session_config": {"session_id": "sess-1"},
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "vnc_enabled": True,
        }
    )

    assert captured["restore"]["vnc_enabled"] is True
    assert result["data"]["vnc_url"] == "https://restored-vnc.example.com"
    assert result["data"]["vnc_password"] == "restored-vnc-password"


@pytest.mark.asyncio
async def test_restore_sandbox_uses_normalized_repo_context(monkeypatch):
    """Snapshot restores should validate and pass a single normalized repo context."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_restore_manager(monkeypatch, captured)
    monkeypatch.setattr(web_api, "resolve_clone_token", lambda: calls.append(True) or "ghs_token")

    result = await _call_restore_sandbox(
        {
            "snapshot_image_id": "img-abc",
            "session_config": {
                "session_id": "sess-1",
                "repo_owner": "  acme  ",
                "repo_name": "  repo  ",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
            },
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    session_config = captured["restore"]["session_config"]

    assert result["success"] is True
    assert calls == [True]
    assert session_config["repo_owner"] == "acme"
    assert session_config["repo_name"] == "repo"
    assert captured["restore"]["clone_token"] == "ghs_token"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_config",
    [
        {"session_id": "sess-1", "repo_owner": "acme"},
        {"session_id": "sess-1", "repo_name": "repo"},
        {"session_id": "sess-1", "repo_owner": "", "repo_name": "repo"},
    ],
)
async def test_restore_sandbox_rejects_partial_repo_context(monkeypatch, session_config):
    _patch_auth(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await _call_restore_sandbox(
            {
                "snapshot_image_id": "img-abc",
                "session_config": {
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-6",
                    **session_config,
                },
                "control_plane_url": "https://control-plane.example",
                "sandbox_auth_token": "sandbox-token",
            }
        )

    assert getattr(exc_info.value, "status_code", None) == 400
    assert "repo_owner and repo_name must be provided together" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_create_sandbox_threads_repositories_into_session_config(monkeypatch):
    """Create reconstructs a typed SessionConfig — new wire fields must be
    threaded explicitly or pydantic silently drops them."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    members = [
        {"repo_owner": "acme", "repo_name": "frontend", "branch": "main"},
        {"repo_owner": "acme", "repo_name": "backend", "branch": "develop"},
    ]
    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "frontend",
            "repositories": members,
            "working_branch_name": "open-inspect/sess-1",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    session_config = captured["config"].session_config
    assert [dict(r) for r in session_config.repositories] == members
    assert session_config.working_branch_name == "open-inspect/sess-1"


@pytest.mark.asyncio
async def test_create_sandbox_repositories_default_to_none(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    assert captured["config"].session_config.repositories is None
    assert captured["config"].session_config.working_branch_name is None


@pytest.mark.asyncio
async def test_restore_sandbox_forwards_session_config_verbatim(monkeypatch):
    """Restore is a pass-through: the session_config dict reaches the manager
    unmodified, so extra keys (repositories, working_branch_name) survive
    without any Python change."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_restore_manager(monkeypatch, captured)

    session_config = {
        "session_id": "sess-1",
        "repo_owner": "acme",
        "repo_name": "frontend",
        "repositories": [
            {
                "repo_owner": "acme",
                "repo_name": "frontend",
                "branch": "main",
                "future_repository_field": {"nested": True},
            },
            {"repo_owner": "acme", "repo_name": "backend", "branch": "develop"},
        ],
        "working_branch_name": "open-inspect/sess-1",
        "some_future_field": {"nested": True},
    }
    result = await _call_restore_sandbox(
        {
            "snapshot_image_id": "im-snap-1",
            "session_config": session_config,
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
        }
    )

    assert result["success"] is True
    assert captured["restore"]["session_config"] == session_config


def test_session_config_helper_prefers_normalized_identity():
    """The helper must take identity from the normalized pair, not the raw request."""
    config = web_api._session_config_from_create_request(
        {"session_id": "s1", "repo_owner": " Acme ", "repo_name": " App "},
        repo_owner="acme",
        repo_name="app",
    )

    assert config.repo_owner == "acme"
    assert config.repo_name == "app"


def test_session_config_helper_ignores_null_wire_values():
    """Explicit nulls on the wire must not clobber SessionConfig defaults."""
    config = web_api._session_config_from_create_request(
        {"session_id": "s1", "provider": None, "model": None, "branch": None},
        repo_owner=None,
        repo_name=None,
    )

    assert config.provider == "anthropic"
    assert config.model == "claude-sonnet-4-6"
    assert config.branch is None
