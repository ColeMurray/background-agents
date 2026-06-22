"""Tests for Modal create-sandbox API request assembly."""

from types import SimpleNamespace

import pytest

from sandbox_runtime.types import SandboxStatus
from src import web_api
from src.sandbox import manager as manager_module


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


def _clear_clone_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [
        "SCM_PROVIDER",
        "GITLAB_ACCESS_TOKEN",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_INSTALLATION_ID",
    ]:
        monkeypatch.delenv(name, raising=False)


async def _call_create_sandbox(request: dict) -> dict:
    return await web_api.api_create_sandbox.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


def test_resolve_clone_token_uses_gitlab_access_token(monkeypatch):
    _clear_clone_token_env(monkeypatch)
    monkeypatch.setenv("SCM_PROVIDER", "gitlab")
    monkeypatch.setenv("GITLAB_ACCESS_TOKEN", "glpat-token")

    assert web_api._resolve_clone_token() == "glpat-token"


def test_resolve_clone_token_returns_none_for_missing_gitlab_token(monkeypatch):
    _clear_clone_token_env(monkeypatch)
    monkeypatch.setenv("SCM_PROVIDER", "gitlab")

    assert web_api._resolve_clone_token() is None


def test_resolve_clone_token_generates_github_installation_token(monkeypatch):
    _clear_clone_token_env(monkeypatch)
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "private-key")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")
    captured = {}

    def fake_generate_installation_token(**kwargs):
        captured.update(kwargs)
        return "ghs-token"

    monkeypatch.setattr("src.auth.generate_installation_token", fake_generate_installation_token)

    assert web_api._resolve_clone_token() == "ghs-token"
    assert captured == {
        "app_id": "123",
        "private_key": "private-key",
        "installation_id": "456",
    }


def test_resolve_clone_token_returns_none_when_github_credentials_incomplete(monkeypatch):
    _clear_clone_token_env(monkeypatch)
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")

    def fail_if_called(**_kwargs):
        raise AssertionError("generate_installation_token should not be called")

    monkeypatch.setattr("src.auth.generate_installation_token", fail_if_called)

    assert web_api._resolve_clone_token() is None


def test_resolve_clone_token_returns_none_when_github_generation_fails(monkeypatch):
    _clear_clone_token_env(monkeypatch)
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "private-key")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")

    def raise_from_generate(**_kwargs):
        raise RuntimeError("token generation failed")

    monkeypatch.setattr("src.auth.generate_installation_token", raise_from_generate)

    assert web_api._resolve_clone_token() is None


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
    assert captured["config"].fallback_clone_token is None


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
    assert calls == []
    assert captured["config"].fallback_clone_token is None


@pytest.mark.asyncio
async def test_create_sandbox_resolves_clone_token_for_snapshot_boot(monkeypatch):
    """Session snapshot boots still receive a legacy fallback token."""
    captured = {}
    calls = []

    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)

    def resolve_clone_token() -> str:
        calls.append(True)
        return "ghs_snapshot"

    monkeypatch.setattr(web_api, "_resolve_clone_token", resolve_clone_token)

    result = await _call_create_sandbox(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control-plane.example",
            "sandbox_auth_token": "sandbox-token",
            "snapshot_id": "snap-1",
        }
    )

    assert result["success"] is True
    assert calls == [True]
    assert captured["config"].fallback_clone_token == "ghs_snapshot"
