"""Internal auth re-exported from sandbox-shared, configured for DAYTONA_API_SECRET."""

from sandbox_shared.auth.internal import (  # noqa: F401
    AuthConfigurationError,
    TOKEN_VALIDITY_SECONDS,
    generate_internal_token as _generate_internal_token,
    verify_internal_token as _verify_internal_token,
)

_ENV_VAR = "DAYTONA_API_SECRET"


def require_secret() -> str:
    """Get the DAYTONA_API_SECRET."""
    from sandbox_shared.auth.internal import require_secret as _require_secret

    return _require_secret(_ENV_VAR)


def generate_internal_token(secret: str | None = None) -> str:
    """Generate an internal API token using DAYTONA_API_SECRET."""
    return _generate_internal_token(secret, env_var=_ENV_VAR)


def verify_internal_token(auth_header: str | None, secret: str | None = None) -> bool:
    """Verify an internal API token using DAYTONA_API_SECRET."""
    return _verify_internal_token(auth_header, secret, env_var=_ENV_VAR)
