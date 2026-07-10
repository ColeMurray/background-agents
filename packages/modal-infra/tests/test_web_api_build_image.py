"""Tests for Modal build-image API request assembly (validation + timeout wiring)."""

from types import SimpleNamespace

import pytest

from src import web_api
from src.sandbox.manager import (
    DEFAULT_BUILD_TIMEOUT_SECONDS,
    build_function_timeout_seconds,
)

REPOSITORIES = [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}]


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)


def _patch_build_image(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
    """Stub build_image so we can capture .with_options(timeout=).spawn.aio(**)."""

    async def fake_aio(**kwargs):
        captured["spawn_kwargs"] = kwargs
        return SimpleNamespace(object_id="fc-1")

    def with_options(**kwargs):
        captured["with_options"] = kwargs
        return SimpleNamespace(spawn=SimpleNamespace(aio=fake_aio))

    monkeypatch.setattr(
        "src.scheduler.image_builder.build_image",
        SimpleNamespace(with_options=with_options),
    )


def _request(**overrides) -> dict:
    request = {
        "scope_kind": "repo",
        "scope_id": "acme/repo",
        "repositories": REPOSITORIES,
        "build_id": "imgb-1",
        "callback_url": "https://cp.test/image-builds/build-complete",
        "failure_callback_url": "https://cp.test/image-builds/build-failed",
    }
    request.update(overrides)
    return {key: value for key, value in request.items() if value is not None}


async def _call_build(request: dict) -> dict:
    return await web_api.api_build_image.get_raw_f()(
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
    _patch_build_image(monkeypatch, captured)

    result = await _call_build(_request(build_timeout_seconds=2400))

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == 2400
    assert captured["with_options"]["timeout"] == build_function_timeout_seconds(2400)


@pytest.mark.asyncio
async def test_build_defaults_timeout_when_absent(monkeypatch):
    """A missing build_timeout_seconds falls back to the default everywhere."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_image(monkeypatch, captured)

    result = await _call_build(_request())

    assert result["success"] is True
    assert captured["spawn_kwargs"]["build_timeout_seconds"] == DEFAULT_BUILD_TIMEOUT_SECONDS
    assert captured["with_options"]["timeout"] == build_function_timeout_seconds(
        DEFAULT_BUILD_TIMEOUT_SECONDS
    )


@pytest.mark.asyncio
async def test_build_forwards_scope_and_repositories(monkeypatch):
    """Scope fields (logging only) and the repository set reach the worker verbatim."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_image(monkeypatch, captured)

    result = await _call_build(_request())

    assert result["success"] is True
    assert captured["spawn_kwargs"]["scope_kind"] == "repo"
    assert captured["spawn_kwargs"]["scope_id"] == "acme/repo"
    assert captured["spawn_kwargs"]["repositories"] == REPOSITORIES
    assert captured["spawn_kwargs"]["callback_url"] == "https://cp.test/image-builds/build-complete"
    assert (
        captured["spawn_kwargs"]["failure_callback_url"]
        == "https://cp.test/image-builds/build-failed"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"build_id": None},
        {"callback_url": None},
        {"failure_callback_url": None},
        {"repositories": None},
        {"repositories": []},
        {"repositories": [{"repo_owner": "acme"}]},
        {"repositories": [{"repo_owner": "acme", "repo_name": "repo"}]},
        {"repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": ""}]},
        {"repositories": [REPOSITORIES[0], {"repo_owner": "acme", "repo_name": "api"}]},
    ],
)
async def test_build_requires_core_fields(monkeypatch, overrides):
    """Validation rejects missing build_id/callback_url/failure_callback_url and
    any repository entry lacking repo_owner/repo_name/branch before spawning."""
    captured = {}
    _patch_auth(monkeypatch)
    _patch_build_image(monkeypatch, captured)

    with pytest.raises(web_api.HTTPException) as exc_info:
        await _call_build(_request(**overrides))

    assert exc_info.value.status_code == 400
    assert "spawn_kwargs" not in captured
