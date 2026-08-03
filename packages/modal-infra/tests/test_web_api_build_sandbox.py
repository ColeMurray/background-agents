"""Tests for the Modal provider-session image-build APIs."""

from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, MagicMock

import pytest

from src import web_api
from src.sandbox.build_session import DEFAULT_BUILD_TIMEOUT_SECONDS

REPOSITORIES = [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}]


def _patch_dependencies(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "validate_control_plane_url", lambda _url: True)
    service = SimpleNamespace(
        create=AsyncMock(return_value="modal-session-1"),
        start=AsyncMock(),
        terminate=AsyncMock(),
        snapshot=AsyncMock(return_value="modal-image-1"),
    )
    monkeypatch.setattr(
        "src.sandbox.build_session.ModalBuildSessionService",
        lambda: service,
    )
    return service


async def _call(endpoint, request: dict) -> dict:
    return await endpoint.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
    )


async def _call_generic_snapshot(request: dict) -> dict:
    return await web_api.api_snapshot_sandbox.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


@pytest.mark.asyncio
async def test_create_build_sandbox_forwards_callback_context_and_returns_provider_session(
    monkeypatch,
):
    service = _patch_dependencies(monkeypatch)

    result = await _call(
        web_api.api_create_build_sandbox,
        {
            "scope_kind": "repo",
            "scope_id": "acme/repo",
            "build_id": "imgb-1",
            "repositories": REPOSITORIES,
            "clone_token": "clone-token",
            "callback_url": "https://worker.test/image-builds/build-complete",
            "failure_callback_url": "https://worker.test/image-builds/build-failed",
            "user_env_vars": {"FOO": "bar"},
            "build_timeout_seconds": 2400,
        },
    )

    assert result == {
        "success": True,
        "data": {"provider_session_id": "modal-session-1"},
    }
    service.create.assert_awaited_once_with(
        build_id="imgb-1",
        scope_kind="repo",
        scope_id="acme/repo",
        repositories=REPOSITORIES,
        callback_url="https://worker.test/image-builds/build-complete",
        failure_callback_url="https://worker.test/image-builds/build-failed",
        clone_token="clone-token",
        clone_host=None,
        clone_username=None,
        user_env_vars={"FOO": "bar"},
        build_execution_timeout_seconds=DEFAULT_BUILD_TIMEOUT_SECONDS,
        timeout_seconds=2400,
    )


@pytest.mark.asyncio
async def test_create_build_sandbox_adds_finalization_grace_to_default_timeout(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    await _call(
        web_api.api_create_build_sandbox,
        {
            "scope_kind": "repo",
            "scope_id": "acme/repo",
            "build_id": "imgb-1",
            "repositories": REPOSITORIES,
        },
    )

    assert service.create.await_args.kwargs["build_execution_timeout_seconds"] == (
        DEFAULT_BUILD_TIMEOUT_SECONDS
    )
    assert service.create.await_args.kwargs["timeout_seconds"] == (
        DEFAULT_BUILD_TIMEOUT_SECONDS + web_api.IMAGE_BUILD_FINALIZATION_GRACE_SECONDS
    )


@pytest.mark.asyncio
async def test_create_build_sandbox_rejects_partial_callback_context(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(
            web_api.api_create_build_sandbox,
            {
                "scope_kind": "repo",
                "scope_id": "acme/repo",
                "build_id": "imgb-1",
                "repositories": REPOSITORIES,
                "callback_url": "https://worker.test/image-builds/build-complete",
            },
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "callback_url and failure_callback_url must be provided together"
    service.create.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("clone_host", ["gitlab.com"]),
        ("clone_host", {"host": "gitlab.com"}),
        ("clone_username", 123),
    ],
)
async def test_create_rejects_non_string_clone_fields(monkeypatch, field, value):
    service = _patch_dependencies(monkeypatch)
    request = {
        "scope_kind": "repo",
        "scope_id": "acme/repo",
        "build_id": "imgb-1",
        "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        field: value,
    }

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(web_api.api_create_build_sandbox, request)

    assert exc.value.status_code == 400
    assert exc.value.detail == f"{field} must be a string"
    service.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_logs_http_outcome(monkeypatch):
    _patch_dependencies(monkeypatch)
    info = MagicMock()
    monkeypatch.setattr(web_api.log, "info", info)

    await _call(
        web_api.api_create_build_sandbox,
        {
            "scope_kind": "repo",
            "scope_id": "acme/repo",
            "build_id": "imgb-1",
            "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        },
    )

    info.assert_called_once_with(
        "modal.http_request",
        http_method="POST",
        http_path="/api_create_build_sandbox",
        http_status=200,
        duration_ms=ANY,
        outcome="success",
        endpoint_name="api_create_build_sandbox",
        trace_id=None,
        request_id=None,
        build_id="imgb-1",
        sandbox_id="modal-session-1",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    ["build_execution_timeout_seconds", "build_timeout_seconds"],
)
async def test_create_rejects_non_integer_build_timeout(monkeypatch, field):
    service = _patch_dependencies(monkeypatch)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(
            web_api.api_create_build_sandbox,
            {
                "scope_kind": "repo",
                "scope_id": "acme/repo",
                "build_id": "imgb-1",
                "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
                field: "1800",
            },
        )

    assert exc.value.status_code == 400
    service.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_clamps_build_timeout_to_provider_maximum(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    await _call(
        web_api.api_create_build_sandbox,
        {
            "scope_kind": "repo",
            "scope_id": "acme/repo",
            "build_id": "imgb-1",
            "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
            "build_timeout_seconds": 99999,
        },
    )

    assert service.create.await_args.kwargs["timeout_seconds"] == 4200


@pytest.mark.asyncio
async def test_create_rejects_case_insensitive_repository_path_collisions(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(
            web_api.api_create_build_sandbox,
            {
                "scope_kind": "environment",
                "scope_id": "env-1",
                "build_id": "imgb-1",
                "repositories": [
                    {
                        "repo_owner": "group/subgroup",
                        "repo_name": "api",
                        "branch": "main",
                    },
                    {
                        "repo_owner": "group/subgroup",
                        "repo_name": "API",
                        "branch": "develop",
                    },
                ],
            },
        )

    assert exc.value.status_code == 400
    assert "duplicate repo_name" in exc.value.detail
    service.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_start_passes_bound_identity_and_callbacks(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    result = await _call(
        web_api.api_start_build_sandbox,
        {
            "build_id": "imgb-1",
            "provider_session_id": "modal-session-1",
            "callback_url": "https://cp.test/image-builds/build-complete",
            "failure_callback_url": "https://cp.test/image-builds/build-failed",
            "callback_token": "callback-token",
        },
    )

    assert result["success"] is True
    service.start.assert_awaited_once_with(
        build_id="imgb-1",
        provider_session_id="modal-session-1",
        callback_url="https://cp.test/image-builds/build-complete",
        failure_callback_url="https://cp.test/image-builds/build-failed",
        callback_token="callback-token",
    )


@pytest.mark.asyncio
async def test_start_logs_callback_validation_failure(monkeypatch):
    service = _patch_dependencies(monkeypatch)
    monkeypatch.setattr(web_api, "validate_control_plane_url", lambda _url: False)
    info = MagicMock()
    monkeypatch.setattr(web_api.log, "info", info)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(
            web_api.api_start_build_sandbox,
            {
                "build_id": "imgb-1",
                "provider_session_id": "modal-session-1",
                "callback_url": "https://attacker.test/complete",
                "failure_callback_url": "https://attacker.test/failed",
                "callback_token": "callback-token",
            },
        )

    assert exc.value.status_code == 400
    service.start.assert_not_awaited()
    assert info.call_args.kwargs["http_status"] == 400
    assert info.call_args.kwargs["outcome"] == "error"


@pytest.mark.asyncio
async def test_terminate_passes_bound_identity_and_reason(monkeypatch):
    service = _patch_dependencies(monkeypatch)

    result = await _call(
        web_api.api_terminate_build_sandbox,
        {
            "build_id": "imgb-1",
            "provider_session_id": "modal-session-1",
            "reason": "image_build_failed",
        },
    )

    assert result == {"success": True, "data": {"terminated": True}}
    service.terminate.assert_awaited_once_with(
        build_id="imgb-1",
        provider_session_id="modal-session-1",
        reason="image_build_failed",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("endpoint_name", "payload"),
    [
        ("api_create_build_sandbox", {"build_id": "imgb-1", "repositories": []}),
        (
            "api_start_build_sandbox",
            {"build_id": "imgb-1", "provider_session_id": "modal-session-1"},
        ),
        ("api_terminate_build_sandbox", {"build_id": "imgb-1"}),
    ],
)
async def test_build_session_endpoints_reject_missing_core_fields(
    monkeypatch, endpoint_name, payload
):
    _patch_dependencies(monkeypatch)

    with pytest.raises(web_api.HTTPException) as exc_info:
        await _call(getattr(web_api, endpoint_name), payload)

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_snapshot_build_uses_dedicated_bound_build_endpoint(monkeypatch):
    service = _patch_dependencies(monkeypatch)
    service.snapshot.return_value = "im-1"

    result = await _call(
        web_api.api_snapshot_build_sandbox,
        {
            "build_id": "imgb-1",
            "provider_session_id": "modal-session-1",
        },
    )

    assert result == {
        "success": True,
        "data": {
            "image_id": "im-1",
            "build_id": "imgb-1",
            "provider_session_id": "modal-session-1",
        },
    }
    service.snapshot.assert_awaited_once_with(
        build_id="imgb-1",
        provider_session_id="modal-session-1",
    )


@pytest.mark.asyncio
async def test_snapshot_build_maps_missing_or_mismatched_session_to_not_found(monkeypatch):
    from src.sandbox.build_session import BuildSessionNotFoundError

    service = _patch_dependencies(monkeypatch)
    service.snapshot.side_effect = BuildSessionNotFoundError("build session not found")

    with pytest.raises(web_api.HTTPException) as exc:
        await _call(
            web_api.api_snapshot_build_sandbox,
            {
                "build_id": "imgb-1",
                "provider_session_id": "modal-session-1",
            },
        )

    assert exc.value.status_code == 404
    assert exc.value.detail == "build session not found"


@pytest.mark.asyncio
async def test_generic_snapshot_reason_cannot_select_build_identity_rules(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    handle = SimpleNamespace()
    manager = SimpleNamespace(
        get_sandbox_by_id=AsyncMock(return_value=handle),
        take_snapshot=AsyncMock(return_value="im-session-1"),
    )
    monkeypatch.setattr("src.sandbox.manager.SandboxManager", lambda: manager)

    result = await _call_generic_snapshot(
        {
            "sandbox_id": "modal-session-1",
            "session_id": "imgb-1",
            "reason": "environment_image_build",
        }
    )

    assert result["data"]["image_id"] == "im-session-1"
    manager.get_sandbox_by_id.assert_awaited_once_with("modal-session-1")
    manager.take_snapshot.assert_awaited_once_with(handle)
