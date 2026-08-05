"""
Internal API authentication utilities.

Provides HMAC-SHA256 time-based token verification for service-to-service
authentication. This mirrors the TypeScript implementation in packages/shared/src/auth.ts.
"""

import hashlib
import hmac
import os
import time

from ..log_config import get_logger

log = get_logger("auth")

# Token validity window in seconds (5 minutes)
TOKEN_VALIDITY_SECONDS = 5 * 60


class AuthConfigurationError(Exception):
    """Raised when authentication is not properly configured."""

    pass


def require_secret() -> str:
    """
    Get the MODAL_API_SECRET, raising an error if not configured.

    This should be called at startup/request time to fail fast if
    authentication is not properly configured.

    Returns:
        The secret value

    Raises:
        AuthConfigurationError: If MODAL_API_SECRET is not set
    """
    secret = os.environ.get("MODAL_API_SECRET")
    if not secret:
        raise AuthConfigurationError(
            "MODAL_API_SECRET environment variable is not configured. "
            "This secret is required for authenticating control plane requests. "
            "Please ensure the 'internal-api' Modal secret is properly configured."
        )
    return secret


def verify_internal_token(auth_header: str | None, secret: str | None = None) -> bool:
    """
    Verify an internal API token from the Authorization header.

    Token format: `Bearer timestamp.signature` where:
    - timestamp: Unix milliseconds when the token was generated
    - signature: HMAC-SHA256 of the timestamp using the shared secret (hex encoded)

    Args:
        auth_header: The Authorization header value (e.g., "Bearer timestamp.signature")
        secret: The shared secret for HMAC verification. If not provided, reads from
                MODAL_API_SECRET environment variable.

    Returns:
        True if the token is valid, False otherwise

    Raises:
        AuthConfigurationError: If secret is not provided and MODAL_API_SECRET is not set
    """
    if secret is None:
        secret = require_secret()

    if not auth_header or not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:]  # Remove "Bearer " prefix
    parts = token.split(".")

    if len(parts) != 2:
        return False

    timestamp_str, signature = parts

    try:
        token_time_ms = int(timestamp_str)
    except ValueError:
        return False

    # Convert to seconds for comparison
    token_time = token_time_ms / 1000
    now = time.time()

    # Reject tokens outside the validity window
    if abs(now - token_time) > TOKEN_VALIDITY_SECONDS:
        log.debug(
            "auth.token_expired",
            age_s=round(abs(now - token_time), 1),
            max_s=TOKEN_VALIDITY_SECONDS,
        )
        return False

    # Compute expected signature
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        timestamp_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Constant-time comparison to prevent timing attacks
    return hmac.compare_digest(signature, expected_signature)
