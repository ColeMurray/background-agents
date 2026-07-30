"""Tests for the additive Modal provider-session image-build APIs."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src import web_api


def _patch_dependencies(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "validate_control_plane_url", lambda _url: True)
    manager = SimpleNamespace(
        create_provider_session_build_sandbox=AsyncMock(
            return_value=SimpleNamespace(modal_object_id="modal-session-1")
        ),
        start_build_sandbox=AsyncMock(),
        terminate_build_sandbox=AsyncMock(),
    )
    monkeypatch.setattr("src.sandbox.manager.SandboxManager", lambda: manager)
    return manager


async def _call(endpoint, request: dict) -> dict:
    return await endpoint.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
    )


@pytest.mark.asyncio
async def test_create_returns_provider_session_without_removing_legacy_endpoint(monkeypatch):
    manager = _patch_dependencies(monkeypatch)

    result = await _call(
        web_api.api_create_build_sandbox,
        {
            "scope_kind": "repo",
            "scope_id": "acme/repo",
            "build_id": "imgb-1",
            "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        },
    )

    assert result["data"]["provider_session_id"] == "modal-session-1"
    manager.create_provider_session_build_sandbox.assert_awaited_once()
    assert hasattr(web_api, "api_build_image")


@pytest.mark.asyncio
async def test_start_passes_bound_identity_and_callbacks(monkeypatch):
    manager = _patch_dependencies(monkeypatch)

    await _call(
        web_api.api_start_build_sandbox,
        {
            "build_id": "imgb-1",
            "provider_session_id": "modal-session-1",
            "callback_url": "https://cp.test/image-builds/build-complete",
            "failure_callback_url": "https://cp.test/image-builds/build-failed",
            "callback_token": "callback-token",
        },
    )

    manager.start_build_sandbox.assert_awaited_once_with(
        build_id="imgb-1",
        provider_session_id="modal-session-1",
        callback_url="https://cp.test/image-builds/build-complete",
        failure_callback_url="https://cp.test/image-builds/build-failed",
        callback_token="callback-token",
    )
