"""Session-bound, access-token-only credentials for the native Codex harness.

The control plane alone owns rotating refresh grants. Each call has one total
deadline (including HTTP/body parsing), never retries, and never trusts a caller
supplied account id. The app-server's previousAccountId is checked by the harness.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypeGuard
from urllib.parse import quote

import httpx

from .provider_credential_client import RuntimeCredentialDenied, RuntimeCredentialUnavailable

if TYPE_CHECKING:
    from ..log_config import StructuredLogger


OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS = 8.0


class OpenAIAccessTokenDenied(RuntimeCredentialDenied):
    """The session/account/credential is no longer eligible; do not fall back to API keys."""


class OpenAIAccessTokenUnavailable(RuntimeCredentialUnavailable):
    """No credential was issued within the current attempt; no automatic turn retry."""


@dataclass(frozen=True)
class OpenAIAccessToken:
    access_token: str = field(repr=False)
    account_id: str
    credential_version: int
    expires_at: int  # Absolute Unix milliseconds, matching the control-plane contract.


class OpenAIAccessTokenClient:
    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
        timeout_seconds: float = OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS,
    ) -> None:
        if not 0 < timeout_seconds <= OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS:
            raise ValueError("OpenAI credential timeout must be positive and at most 8 seconds")
        self._url = (
            f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}"
            "/provider-auth/openai/access-token"
        )
        self._auth_token = auth_token
        self._log = log
        self._http_client = http_client
        self._timeout_seconds = timeout_seconds

    async def fetch(
        self,
        *,
        rejected_credential_version: int | None = None,
        timeout_seconds: float | None = None,
    ) -> OpenAIAccessToken:
        budget = (
            min(self._timeout_seconds, timeout_seconds)
            if timeout_seconds is not None
            else self._timeout_seconds
        )
        if budget <= 0:
            raise OpenAIAccessTokenUnavailable("OpenAI credential deadline exceeded")
        if rejected_credential_version is not None and not _positive_integer(
            rejected_credential_version
        ):
            raise OpenAIAccessTokenDenied("Invalid rejected credential version")
        body = (
            {}
            if rejected_credential_version is None
            else {
                "reason": "unauthorized",
                "rejectedCredentialVersion": rejected_credential_version,
            }
        )
        # Wall-clock deadline lets the CP shorten its wait; the outer monotonic
        # timeout remains authoritative even with clock skew or a slow transport.
        deadline_ms = int((time.time() + budget - min(0.25, budget / 10)) * 1000)
        headers = {
            "Authorization": f"Bearer {self._auth_token}",
            "X-Provider-Deadline-Ms": str(deadline_ms),
        }
        try:
            async with asyncio.timeout(budget):
                if self._http_client is None:
                    async with httpx.AsyncClient(timeout=budget) as client:
                        response = await client.post(self._url, headers=headers, json=body)
                else:
                    response = await self._http_client.post(
                        self._url,
                        headers=headers,
                        json=body,
                        timeout=budget,
                    )
                credential = self._parse(response, rejected_credential_version)
        except TimeoutError:
            raise OpenAIAccessTokenUnavailable("OpenAI credential deadline exceeded") from None
        except httpx.HTTPError:
            raise OpenAIAccessTokenUnavailable("OpenAI credential transport unavailable") from None
        self._log.info("openai_credential.issued", credential_version=credential.credential_version)
        return credential

    @staticmethod
    def _parse(response: httpx.Response, rejected_version: int | None) -> OpenAIAccessToken:
        status = response.status_code
        # Never echo response text/JSON errors: a proxy/provider may include secrets.
        if status in (408, 425, 429) or status >= 500:
            raise OpenAIAccessTokenUnavailable(f"OpenAI credential unavailable (HTTP {status})")
        if len(response.content) > 64 * 1024:
            raise OpenAIAccessTokenUnavailable("OpenAI credential response exceeded its size limit")
        try:
            body = response.json()
        except ValueError:
            if status == 200:
                raise OpenAIAccessTokenUnavailable(
                    "OpenAI credential response was incomplete"
                ) from None
            raise OpenAIAccessTokenDenied(f"OpenAI credential denied (HTTP {status})") from None
        if status == 409 and isinstance(body, dict) and body.get("retryable") is True:
            raise OpenAIAccessTokenUnavailable("OpenAI credential refresh is busy")
        if status != 200:
            raise OpenAIAccessTokenDenied(f"OpenAI credential denied (HTTP {status})")
        if not isinstance(body, dict):
            raise OpenAIAccessTokenDenied("Invalid OpenAI credential response")
        access = body.get("accessToken")
        account = body.get("externalAccountId")
        version = body.get("credentialVersion")
        expiry = body.get("expiresAt")
        metadata = body.get("providerMetadata")
        if (
            not isinstance(access, str)
            or not access
            or not isinstance(account, str)
            or not account
            or not _positive_integer(version)
            or not _positive_integer(expiry)
            or expiry <= int(time.time() * 1000)
            or (rejected_version is not None and version <= rejected_version)
            or (
                metadata is not None
                and (
                    not isinstance(metadata, dict)
                    or (metadata.get("accountId") is not None and metadata["accountId"] != account)
                )
            )
        ):
            raise OpenAIAccessTokenDenied("Invalid OpenAI credential identity, version or expiry")
        return OpenAIAccessToken(access, account, version, expiry)


def _positive_integer(value: object) -> TypeGuard[int]:
    return type(value) is int and 0 < value <= 2**53 - 1
