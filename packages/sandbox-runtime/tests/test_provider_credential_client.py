"""The sandbox-side runtime-credential client: denial is final; the moment is not."""

from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.credentials.provider_credential_client import (
    RuntimeCredentialClient,
    RuntimeCredentialDenied,
    RuntimeCredentialUnavailable,
)


def _client(handler) -> tuple[RuntimeCredentialClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(transport_handler))
    client = RuntimeCredentialClient(
        control_plane_url="https://cp.example/",
        session_id="session 1",
        sandbox_id="sb-1",
        auth_token="sandbox-token",
        log=MagicMock(),
        http_client=http,
    )
    return client, seen


@pytest.mark.asyncio
async def test_fetch_posts_with_sandbox_principal_headers_and_returns_the_secret() -> None:
    client, seen = _client(
        lambda _request: httpx.Response(
            200,
            json={
                "kind": "stored_provider_secret",
                "secret": "sk-ant-oat01-abc",
                "credentialVersion": 3,
                "expiresAt": 1_800_000_000_000,
            },
        )
    )
    credential = await client.fetch("anthropic")

    assert credential.secret == "sk-ant-oat01-abc"
    assert credential.credential_version == 3
    assert credential.expires_at == 1_800_000_000_000
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == (
        "https://cp.example/sessions/session%201/provider-auth/anthropic/runtime-credential"
    )
    assert request.headers["Authorization"] == "Bearer sandbox-token"
    assert request.headers["X-Sandbox-ID"] == "sb-1"


@pytest.mark.parametrize("status", [401, 403, 404, 409, 410])
@pytest.mark.asyncio
async def test_denials_are_final(status: int) -> None:
    client, _ = _client(lambda _r: httpx.Response(status, json={"error": "account disabled"}))
    with pytest.raises(RuntimeCredentialDenied, match="account disabled"):
        await client.fetch("anthropic")


@pytest.mark.parametrize("status", [408, 425, 429])
@pytest.mark.asyncio
async def test_timeouts_and_rate_limits_are_transient(status: int) -> None:
    client, _ = _client(lambda _r: httpx.Response(status, json={"error": "slow down"}))
    with pytest.raises(RuntimeCredentialUnavailable):
        await client.fetch("anthropic")


@pytest.mark.asyncio
async def test_the_issuance_race_is_transient_while_other_conflicts_are_final() -> None:
    client, _ = _client(
        lambda _r: httpx.Response(
            409,
            json={"error": "Provider account changed during issuance; retry", "retryable": True},
        )
    )
    with pytest.raises(RuntimeCredentialUnavailable):
        await client.fetch("anthropic")
    client, _ = _client(lambda _r: httpx.Response(409, json={"error": "expired"}))
    with pytest.raises(RuntimeCredentialDenied, match="expired"):
        await client.fetch("anthropic")


@pytest.mark.asyncio
async def test_server_errors_are_transient() -> None:
    client, _ = _client(lambda _r: httpx.Response(503, text="try later"))
    with pytest.raises(RuntimeCredentialUnavailable):
        await client.fetch("anthropic")


@pytest.mark.asyncio
async def test_transport_errors_are_transient() -> None:
    def boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client, _ = _client(boom)
    with pytest.raises(RuntimeCredentialUnavailable):
        await client.fetch("anthropic")


@pytest.mark.asyncio
async def test_an_undecodable_success_body_is_transient() -> None:
    client, _ = _client(lambda _r: httpx.Response(200, text=""))
    with pytest.raises(RuntimeCredentialUnavailable, match="not valid JSON"):
        await client.fetch("anthropic")


@pytest.mark.asyncio
async def test_a_brokered_token_is_rejected_as_the_wrong_kind() -> None:
    client, _ = _client(
        lambda _r: httpx.Response(200, json={"kind": "brokered_access_token", "secret": "x"})
    )
    with pytest.raises(RuntimeCredentialDenied, match="stored_provider_secret"):
        await client.fetch("anthropic")


async def test_restarted_bridge_discovers_current_revision_without_relaxing_switch_fence() -> None:
    binding = {"bindingRevision": 2, "generation": {"sandboxId": "sb-1", "createdAt": 100}}

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=binding)
        if request.headers.get("x-provider-binding-revision") != "2":
            return httpx.Response(409, json={"error": "stale_provider_binding"})
        return httpx.Response(
            200, json={**binding, "kind": "stored_provider_secret", "secret": "new-secret"}
        )

    client, seen = _client(handler)
    assert (await client.fetch("anthropic")).secret == "new-secret"
    assert [request.method for request in seen] == ["POST", "GET", "POST"]
    with pytest.raises(RuntimeCredentialDenied):
        await client.fetch("anthropic", {**binding, "bindingRevision": 1})
    assert len(seen) == 4
