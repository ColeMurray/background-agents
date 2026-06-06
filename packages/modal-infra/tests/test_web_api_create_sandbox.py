"""Tests for Modal create-sandbox API request assembly."""

from types import SimpleNamespace

import pytest

from sandbox_runtime.types import SandboxStatus
from src import web_api
from src.sandbox import manager as manager_module
from src.scheduler import image_builder as image_builder_module


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "require_valid_control_plane_url", lambda _url: None)


def _patch_manager(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
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
                ttyd_url=None,
                tunnel_urls=None,
            )

    monkeypatch.setattr(manager_module, "SandboxManager", FakeManager)


async def _call_create_sandbox(request: dict) -> dict:
    return await web_api.api_create_sandbox.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


async def _call_build_repo_image(request: dict) -> dict:
    return await web_api.api_build_repo_image.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
    )


@pytest.mark.asyncio
async def test_create_sandbox_does_not_resolve_clone_token_for_fresh_boot(monkeypatch):
    """Fresh base-image boots authenticate via the credential helper only."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)
    monkeypatch.setattr(web_api, "_resolve_clone_token", lambda: calls.append(True) or "ghs_token")

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
    assert captured["config"].clone_token is None


@pytest.mark.asyncio
async def test_create_sandbox_resolves_clone_token_for_prebuilt_boot(monkeypatch):
    """Repo images may run pre-migration entrypoints, so they still need a fallback token."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    def resolve_clone_token() -> str:
        calls.append(True)
        return "ghs_prebuilt"

    monkeypatch.setattr(web_api, "_resolve_clone_token", resolve_clone_token)

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
    assert calls == [True]
    assert captured["config"].clone_token == "ghs_prebuilt"


@pytest.mark.asyncio
async def test_build_repo_image_forwards_image_profile(monkeypatch):
    captured = {}

    _patch_auth(monkeypatch)

    async def fake_spawn_aio(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        image_builder_module,
        "build_repo_image",
        SimpleNamespace(spawn=SimpleNamespace(aio=fake_spawn_aio)),
    )

    result = await _call_build_repo_image(
        {
            "repo_owner": "acme",
            "repo_name": "repo",
            "default_branch": "main",
            "build_id": "build-1",
            "callback_url": "https://control-plane.example/repo-images/build-complete",
            "image_profile": "docker",
        }
    )

    assert result["success"] is True
    assert "sandbox_settings" not in captured
    assert captured["image_profile"] == "docker"
