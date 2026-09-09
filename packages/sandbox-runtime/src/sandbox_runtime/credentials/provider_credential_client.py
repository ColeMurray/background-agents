"""Sandbox-side client for platform-managed provider credentials.

The Claude harness fetches its subscription credential (a Claude setup token)
from the control plane's sandbox-only bootstrap endpoint on every bridge
start, so a supervised restart and a snapshot restore both re-fetch and each
fetch is an issuance record on the control plane. The token lives in process
memory only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from ..log_config import StructuredLogger

RUNTIME_CREDENTIAL_TIMEOUT_SECONDS: Final = 30.0
BOOTSTRAP_SECRET_KIND: Final = "sandbox_bootstrap_secret"


class RuntimeCredentialDenied(Exception):
    """The control plane refused to issue the credential; retrying is futile.

    Raised for 401/403/404/409/410 (disabled, archived, expired or unbound
    account; wrong provider; dead sandbox). The message is user-facing.
    """


class RuntimeCredentialUnavailable(Exception):
    """A transient failure (network, 5xx); the caller may retry."""


@dataclass(frozen=True)
class RuntimeCredential:
    kind: str
    secret: str
    credential_version: int | None
    expires_at: int | None


class RuntimeCredentialClient:
    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        sandbox_id: str,
        auth_token: str,
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
        timeout_seconds: float = RUNTIME_CREDENTIAL_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = control_plane_url.rstrip("/")
        self._session_id = session_id
        self._sandbox_id = sandbox_id
        self._auth_token = auth_token
        self._log = log
        self._http_client = http_client
        self._timeout_seconds = timeout_seconds

    def _url(self, provider: str) -> str:
        session = quote(self._session_id, safe="")
        return f"{self._base_url}/sessions/{session}/provider-auth/{provider}/runtime-credential"

    async def fetch(self, provider: str) -> RuntimeCredential:
        """Fetch the session-bound credential for ``provider`` (``anthropic`` today)."""
        headers = {
            "Authorization": f"Bearer {self._auth_token}",
            "X-Sandbox-ID": self._sandbox_id,
        }
        try:
            if self._http_client is not None:
                response = await self._http_client.post(
                    self._url(provider), headers=headers, json={}, timeout=self._timeout_seconds
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                    response = await client.post(self._url(provider), headers=headers, json={})
        except httpx.HTTPError as error:
            raise RuntimeCredentialUnavailable(str(error)) from error

        if response.status_code in (401, 403, 404, 409, 410):
            raise RuntimeCredentialDenied(self._denial_message(provider, response))
        if response.status_code >= 500:
            raise RuntimeCredentialUnavailable(
                f"control plane returned HTTP {response.status_code} for the {provider} credential"
            )
        if response.status_code != 200:
            raise RuntimeCredentialDenied(self._denial_message(provider, response))

        body: Any = response.json()
        if not isinstance(body, dict):
            raise RuntimeCredentialDenied("credential response was not an object")
        kind = body.get("kind")
        secret = body.get("secret")
        if kind != BOOTSTRAP_SECRET_KIND or not isinstance(secret, str) or not secret:
            raise RuntimeCredentialDenied(
                f"credential response for {provider} was not a {BOOTSTRAP_SECRET_KIND}"
            )
        version = body.get("credentialVersion")
        expires_at = body.get("expiresAt")
        self._log.info(
            "provider_credential.issued",
            provider=provider,
            credential_version=version if isinstance(version, int) else None,
        )
        return RuntimeCredential(
            kind=kind,
            secret=secret,
            credential_version=version if isinstance(version, int) else None,
            expires_at=expires_at if isinstance(expires_at, int) else None,
        )

    @staticmethod
    def _denial_message(provider: str, response: httpx.Response) -> str:
        detail = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("error") or body.get("message") or "")
        except ValueError:
            detail = response.text[:200]
        suffix = f": {detail}" if detail else ""
        return (
            f"The control plane refused the {provider} subscription credential "
            f"(HTTP {response.status_code}){suffix}. Reconnect the account in Settings "
            "and start a new session."
        )
