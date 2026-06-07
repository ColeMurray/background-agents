import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    CALLBACK_USER_AGENT,
    RepoImageBuildCallback,
    build_failed_callback_url,
)


def test_from_env_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv(BUILD_ID_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)

    assert RepoImageBuildCallback.from_env() is None


def test_from_env_rejects_partial_configuration(monkeypatch):
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")

    assert RepoImageBuildCallback.from_env(logger) is None
    logger.error.assert_called_once()


def test_build_failed_callback_url():
    assert (
        build_failed_callback_url("https://cp.test/repo-images/build-complete")
        == "https://cp.test/repo-images/build-failed"
    )
    assert (
        build_failed_callback_url("https://cp.test/custom-callback")
        == "https://cp.test/custom-callback"
    )


@pytest.mark.asyncio
async def test_report_success_posts_authenticated_payload(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)

    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        token="callback-token",
        provider_session_id="vercel-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_success(base_sha="abc123", build_duration_seconds=12.3456)

    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://cp.test/repo-images/build-complete"
    assert request.headers["authorization"] == "Bearer callback-token"
    assert request.headers["user-agent"] == CALLBACK_USER_AGENT
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {
        "build_id": "build-1",
        "base_sha": "abc123",
        "build_duration_seconds": 12.346,
        "provider_session_id": "vercel-session-1",
    }


@pytest.mark.asyncio
async def test_report_failure_posts_to_failed_endpoint_and_truncates_error(monkeypatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    _patch_async_client(monkeypatch, handler)
    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        token="callback-token",
        provider_session_id="vercel-session-1",
        logger=MagicMock(),
    )

    assert await reporter.report_failure("x" * 600)

    assert str(requests[0].url) == "https://cp.test/repo-images/build-failed"
    assert json.loads(requests[0].content) == {
        "build_id": "build-1",
        "error": "x" * 500,
        "provider_session_id": "vercel-session-1",
    }


@pytest.mark.asyncio
async def test_retries_transient_callback_failures(monkeypatch):
    responses = [httpx.Response(503), httpx.Response(200)]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses.pop(0)

    _patch_async_client(monkeypatch, handler)
    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.repo_image_callback.asyncio.sleep", sleep)

    reporter = RepoImageBuildCallback(
        build_id="build-1",
        callback_url="https://cp.test/repo-images/build-complete",
        token="callback-token",
        logger=MagicMock(),
    )

    assert await reporter.report_success(base_sha="", build_duration_seconds=1.0)
    assert len(requests) == 2
    sleep.assert_awaited_once_with(2)


def _patch_async_client(monkeypatch, handler):
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr("sandbox_runtime.repo_image_callback.httpx.AsyncClient", factory)
