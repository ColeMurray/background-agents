"""Tests for Modal build-repo-image API request assembly (timeout wiring)."""

from types import SimpleNamespace

import pytest

from src import web_api
from src.sandbox.manager import (
    DEFAULT_BUILD_TIMEOUT_SECONDS,
    build_function_timeout_seconds,
)


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)


def _patch_build_repo_image(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
    """Stub build_repo_image so we can capture .with_options(timeout=).spawn.aio(**)."""

    async def fake_aio(**kwargs):
        captured["spawn_kwargs"] = kwargs
        return SimpleNamespace(object_id="fc-1")

    def with_options(**kwargs):
        captured["with_options"] = kwargs
        return SimpleNamespace(spawn=SimpleNamespace(aio=fake_aio))

    monkeypatch.setattr(
        "src.scheduler.image_builder.build_repo_image",
        SimpleNamespace(with_options=with_options),
    )


async def _call_build(request: dict) -> dict:
    return await web_api.api_build_repo_image.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
    )


@pytest.mark.asyncio
async def test_build_uses_requested_timeout_for_sandbox_and_function(monkeypatch):
    """The requested build timeout drives the sandbox lifetime and the worker timeout."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    result = await _call_build(
        {
            "repo_owner": "acme",
            "repo_name": "repo",
            "default_branch": "main",
            "build_id": "img-1",
            "callback_url": "https://cp.test/repo-images/build-complete",
            "build_timeout_seconds": 2400,
        }
    )

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == 2400
    assert captured["with_options"]["timeout"] == build_function_timeout_seconds(2400)


@pytest.mark.asyncio
async def test_build_defaults_timeout_when_absent(monkeypatch):
    """A missing build_timeout_seconds falls back to the default everywhere."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    result = await _call_build(
        {
            "repo_owner": "acme",
            "repo_name": "repo",
            "default_branch": "main",
            "build_id": "img-1",
            "callback_url": "https://cp.test/repo-images/build-complete",
        }
    )

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == DEFAULT_BUILD_TIMEOUT_SECONDS
    assert captured["with_options"]["timeout"] == build_function_timeout_seconds(
        DEFAULT_BUILD_TIMEOUT_SECONDS
    )


@pytest.mark.asyncio
async def test_build_requires_core_fields(monkeypatch):
    """Validation still rejects missing identifiers before spawning."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_repo_image(monkeypatch, captured)

    with pytest.raises(web_api.HTTPException) as exc_info:
        await _call_build(
            {
                "repo_name": "repo",
                "default_branch": "main",
                "build_id": "img-1",
                "callback_url": "https://cp.test/repo-images/build-complete",
            }
        )

    assert exc_info.value.status_code == 400
    assert "spawn_kwargs" not in captured
