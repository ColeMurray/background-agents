import asyncio
import json
import time
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.credentials.openai_access_token_client import (
    OpenAIAccessTokenClient,
    OpenAIAccessTokenDenied,
    OpenAIAccessTokenUnavailable,
)


def response_body(**overrides):
    return {
        "accessToken": "access-secret",
        "externalAccountId": "workspace",
        "credentialVersion": 3,
        "expiresAt": int(time.time() * 1000) + 3_600_000,
        **overrides,
    }


def client(handler, timeout=8):
    log = MagicMock()
    return OpenAIAccessTokenClient(
        control_plane_url="https://cp.example/",
        session_id="session 1",
        auth_token="sandbox-secret",
        log=log,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        timeout_seconds=timeout,
    ), log


@pytest.mark.asyncio
async def test_fetch_uses_only_bound_route_and_version_not_account_or_rejected_token():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=response_body())

    c, log = client(handler)
    token = await c.fetch(rejected_credential_version=2)
    assert (token.access_token, token.account_id, token.credential_version) == (
        "access-secret",
        "workspace",
        3,
    )
    request = seen[0]
    assert (
        str(request.url)
        == "https://cp.example/sessions/session%201/provider-auth/openai/access-token"
    )
    assert request.headers["Authorization"] == "Bearer sandbox-secret"
    assert int(request.headers["X-Provider-Deadline-Ms"]) > int(time.time() * 1000)
    assert json.loads(request.content) == {"reason": "unauthorized", "rejectedCredentialVersion": 2}
    assert "access-secret" not in repr(log.mock_calls)
    assert "access-secret" not in repr(token)


@pytest.mark.parametrize(
    "patch",
    [
        {"credentialVersion": True},
        {"credentialVersion": 0},
        {"credentialVersion": "3"},
        {"externalAccountId": ""},
        {"externalAccountId": None},
        {"accessToken": ""},
        {"expiresAt": True},
        {"expiresAt": 1},
        {"providerMetadata": {"accountId": "wrong-workspace"}},
    ],
)
@pytest.mark.asyncio
async def test_invalid_or_mismatched_metadata_fails_closed(patch):
    c, _ = client(lambda _: httpx.Response(200, json=response_body(**patch)))
    with pytest.raises(OpenAIAccessTokenDenied):
        await c.fetch()


@pytest.mark.asyncio
async def test_rejected_version_must_be_replaced():
    c, _ = client(lambda _: httpx.Response(200, json=response_body()))
    with pytest.raises(OpenAIAccessTokenDenied):
        await c.fetch(rejected_credential_version=3)


@pytest.mark.parametrize("status", [401, 403, 404, 409, 410])
@pytest.mark.asyncio
async def test_denial_never_echoes_untrusted_error_body(status):
    c, _ = client(
        lambda _: httpx.Response(status, json={"error": "sensitive bearer provider body"})
    )
    with pytest.raises(OpenAIAccessTokenDenied) as exc:
        await c.fetch()
    assert "sensitive" not in str(exc.value)


@pytest.mark.parametrize("status", [408, 429, 502, 503, 504])
@pytest.mark.asyncio
async def test_transient_response_has_no_automatic_retry(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, text="sensitive")

    c, _ = client(handler)
    with pytest.raises(OpenAIAccessTokenUnavailable):
        await c.fetch()
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_total_deadline_includes_mock_transport_delay_and_is_sanitized():
    async def slow(_):
        await asyncio.sleep(1)
        return httpx.Response(200, json=response_body())

    c, _ = client(slow, timeout=0.01)
    before = time.monotonic()
    with pytest.raises(OpenAIAccessTokenUnavailable, match="deadline"):
        await c.fetch()
    assert time.monotonic() - before < 0.2


@pytest.mark.asyncio
async def test_transport_exception_does_not_leak_token_or_url():
    def handler(_):
        raise httpx.ConnectError("secret@example.invalid/path?token=secret")

    c, _ = client(handler)
    with pytest.raises(OpenAIAccessTokenUnavailable) as exc:
        await c.fetch()
    assert "secret" not in str(exc.value)
