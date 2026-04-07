"""Internal request authentication for the Daytona shim service."""

from __future__ import annotations

import hashlib
import hmac
import os
import time

TOKEN_VALIDITY_SECONDS = 5 * 60


class AuthConfigurationError(Exception):
    """Raised when the service auth secret is not configured."""


def require_service_secret() -> str:
    """Return the configured service secret."""
    secret = os.environ.get("DAYTONA_SERVICE_SECRET")
    if not secret:
        raise AuthConfigurationError("DAYTONA_SERVICE_SECRET is required")
    return secret


def verify_internal_token(auth_header: str | None) -> bool:
    """Verify the control-plane HMAC bearer token."""
    secret = require_service_secret()

    if not auth_header or not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:]
    timestamp_str, signature = token.split(".", 1) if "." in token else ("", "")
    if not timestamp_str or not signature:
        return False

    try:
        token_time_ms = int(timestamp_str)
    except ValueError:
        return False

    now_ms = int(time.time() * 1000)
    if abs(now_ms - token_time_ms) > TOKEN_VALIDITY_SECONDS * 1000:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def derive_code_server_password(logical_sandbox_id: str) -> str:
    """Derive a stable code-server password for a logical sandbox."""
    secret = require_service_secret()
    digest = hmac.new(
        secret.encode("utf-8"),
        f"code-server:{logical_sandbox_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest[:32]
