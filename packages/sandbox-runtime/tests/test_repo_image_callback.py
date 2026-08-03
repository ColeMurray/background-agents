import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    CALLBACK_USER_AGENT,
    FAILURE_CALLBACK_URL_ENV,
    MODAL_SANDBOX_ID_ENV,
    ModalImageBuildStartCancelled,
    RepoImageBuildCallback,
    read_modal_callback_token,
)


def test_from_env_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv(BUILD_ID_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(FAILURE_CALLBACK_URL_ENV, raising=False)
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)

    assert RepoImageBuildCallback.from_env() is None


def test_from_env_rejects_partial_configuration(monkeypatch):
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.delenv(CALLBACK_URL_ENV, raising=False)
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/repo-images/build-failed")
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")

    assert RepoImageBuildCallback.from_env(logger) is None
    logger.error.assert_called_once()


def test_from_env_rejects_missing_failure_callback_url(monkeypatch):
    logger = MagicMock()
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/repo-images/build-complete")
    monkeypatch.delenv(FAILURE_CALLBACK_URL_ENV, raising=False)
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")

    assert RepoImageBuildCallback.from_env(logger) is None
    logger.error.assert_called_once()


def test_from_env_reads_both_callback_urls(monkeypatch):
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/repo-images/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/repo-images/build-failed")
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "callback-token")

    reporter = RepoImageBuildCallback.from_env()
    assert reporter is not None
    assert reporter.callback_url == "https://cp.test/repo-images/build-complete"
    assert reporter.failure_callback_url == "https://cp.test/repo-images/build-failed"


def test_from_modal_token_uses_create_context_and_modal_identity(monkeypatch):
    token = "a" * 64
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/image-builds/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/image-builds/build-failed")
    monkeypatch.setenv(MODAL_SANDBOX_ID_ENV, "sb-modal-1")
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)

    reporter = RepoImageBuildCallback.from_modal_token(token)

    assert reporter.build_id == "build-1"
    assert reporter.provider_session_id == "sb-modal-1"
    assert reporter.callback_url == "https://cp.test/image-builds/build-complete"
    assert reporter.failure_callback_url == "https://cp.test/image-builds/build-failed"
    assert reporter.token == token


def test_from_modal_token_rejects_invalid_token(monkeypatch):
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/image-builds/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/image-builds/build-failed")
    monkeypatch.setenv(MODAL_SANDBOX_ID_ENV, "sb-modal-1")

    with pytest.raises(ValueError, match="invalid callback token"):
        RepoImageBuildCallback.from_modal_token("callback-token")


def test_from_modal_token_rejects_missing_create_context(monkeypatch):
    monkeypatch.setenv(BUILD_ID_ENV, "build-1")
    monkeypatch.setenv(CALLBACK_URL_ENV, "https://cp.test/image-builds/build-complete")
    monkeypatch.setenv(FAILURE_CALLBACK_URL_ENV, "https://cp.test/image-builds/build-failed")
    monkeypatch.delenv(MODAL_SANDBOX_ID_ENV, raising=False)

    with pytest.raises(ValueError, match=MODAL_SANDBOX_ID_ENV):
        RepoImageBuildCallback.from_modal_token("a" * 64)


@pytest.mark.asyncio
async def test_reads_one_modal_callback_token_line():
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())

    token = await read_modal_callback_token(reader, asyncio.Event())

    assert token == "a" * 64


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (b"not-a-token\n", "invalid callback token"),
        (("a" * 65 + "\n").encode(), "callback token too large"),
        (("a" * 64).encode(), "incomplete callback token"),
        (b"", "stdin closed"),
    ],
)
async def test_rejects_invalid_modal_callback_token_lines(payload, reason):
    reader = asyncio.StreamReader()
    if payload:
        reader.feed_data(payload)
    reader.feed_eof()

    with pytest.raises(ValueError, match=reason):
        await read_modal_callback_token(reader, asyncio.Event())


@pytest.mark.asyncio
async def test_shutdown_cancels_modal_callback_token_read():
    reader = asyncio.StreamReader()
    reader.feed_data(b"a")
    shutdown_event = asyncio.Event()
    operation = asyncio.create_task(read_modal_callback_token(reader, shutdown_event))
    await asyncio.sleep(0)

    shutdown_event.set()

    with pytest.raises(ModalImageBuildStartCancelled):
        await operation


@pytest.mark.asyncio
async def test_cancelling_modal_callback_token_read_cleans_up_reader_task():
    read_cancelled = asyncio.Event()

    class BlockingReader:
        async def readline(self):
            try:
                await asyncio.Event().wait()
            finally:
                read_cancelled.set()

    operation = asyncio.create_task(read_modal_callback_token(BlockingReader(), asyncio.Event()))
    await asyncio.sleep(0)

    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation

    assert read_cancelled.is_set()


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
        failure_callback_url="https://cp.test/repo-images/build-failed",
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
        failure_callback_url="https://cp.test/repo-images/build-failed",
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
        failure_callback_url="https://cp.test/repo-images/build-failed",
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
