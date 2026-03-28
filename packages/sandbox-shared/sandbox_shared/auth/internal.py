"""
Internal API authentication utilities.

Provides HMAC-SHA256 time-based token verification for service-to-service
authentication. This mirrors the TypeScript implementation in packages/shared/src/auth.ts.
"""

import hashlib
import hmac
import os
import time

from ..sandbox.log_config import get_logger

log = get_logger("auth")

# Token validity window in seconds (5 minutes)
TOKEN_VALIDITY_SECONDS = 5 * 60

# Default env var name for the shared secret; each provider can override.
DEFAULT_SECRET_ENV_VAR = "SANDBOX_API_SECRET"


class AuthConfigurationError(Exception):
    """Raised when authentication is not properly configured."""

    pass


def require_secret(env_var: str = DEFAULT_SECRET_ENV_VAR) -> str:
    """
    Get the API secret from an environment variable, raising an error if not configured.

    Args:
        env_var: Environment variable name to read (default: SANDBOX_API_SECRET).
                 Modal uses MODAL_API_SECRET, Daytona uses DAYTONA_API_SECRET.

    Returns:
        The secret value

    Raises:
        AuthConfigurationError: If the env var is not set
    """
    secret = os.environ.get(env_var)
    if not secret:
        raise AuthConfigurationError(
            f"{env_var} environment variable is not configured. "
            "This secret is required for authenticating control plane requests."
        )
    return secret


def generate_internal_token(
    secret: str | None = None, env_var: str = DEFAULT_SECRET_ENV_VAR
) -> str:
    """
    Generate an internal API token for service-to-service calls.

    Token format: `timestamp.signature` where:
    - timestamp: Unix milliseconds when the token was generated
    - signature: HMAC-SHA256 of the timestamp using the shared secret (hex encoded)

    Args:
        secret: The shared secret for HMAC signing. If not provided, reads from env_var.
        env_var: Environment variable to read secret from if not provided directly.

    Returns:
        A token string in the format "timestamp.signature"

    Raises:
        AuthConfigurationError: If secret is not provided and env var is not set
    """
    if secret is None:
        secret = require_secret(env_var)

    timestamp_str = str(int(time.time() * 1000))

    signature = hmac.new(
        secret.encode("utf-8"),
        timestamp_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return f"{timestamp_str}.{signature}"


def verify_internal_token(
    auth_header: str | None,
    secret: str | None = None,
    env_var: str = DEFAULT_SECRET_ENV_VAR,
) -> bool:
    """
    Verify an internal API token from the Authorization header.

    Args:
        auth_header: The Authorization header value (e.g., "Bearer timestamp.signature")
        secret: The shared secret for HMAC verification. If not provided, reads from env_var.
        env_var: Environment variable to read secret from if not provided directly.

    Returns:
        True if the token is valid, False otherwise

    Raises:
        AuthConfigurationError: If secret is not provided and env var is not set
    """
    if secret is None:
        secret = require_secret(env_var)

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
