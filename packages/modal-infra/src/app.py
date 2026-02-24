"""
Main Modal application definition for Open-Inspect.

This module defines the Modal app and shared resources used across
all sandbox operations.
"""

import os
from urllib.parse import urlparse

import modal

from .log_config import get_logger

log = get_logger("app")

# Main Modal application
app = modal.App("open-inspect")

# Image for Modal functions (not sandbox)
# Includes all dependencies needed by the function modules at import time
function_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")  # For scheduler git ls-remote checks
    .pip_install(
        "pydantic>=2.0",
        "httpx",
        "fastapi",
        "modal",  # Required for sandbox.manager imports
        "PyJWT[crypto]",  # For GitHub App token generation
    )
)

# Secrets for LLM API keys - defined in Modal dashboard or CLI
# These are injected into sandboxes but never stored in snapshots
llm_secrets = modal.Secret.from_name(
    "llm-api-keys",
    required_keys=["ANTHROPIC_API_KEY"],
)

# Secrets for GitHub App - used for git operations (clone, push)
# These are used to generate installation tokens, NOT injected into sandboxes
github_app_secrets = modal.Secret.from_name(
    "github-app",
    required_keys=["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"],
)

# Secret for internal API authentication (bidirectional)
# MODAL_API_SECRET: verify requests from control plane to Modal endpoints
# INTERNAL_CALLBACK_SECRET: sign requests from Modal to control plane
# Also contains ALLOWED_CONTROL_PLANE_HOSTS for URL validation
internal_api_secret = modal.Secret.from_name(
    "internal-api",
    required_keys=["MODAL_API_SECRET", "INTERNAL_CALLBACK_SECRET"],
)


def _get_allowed_hosts() -> set[str]:
    """
    Get the set of allowed control plane hosts from environment.

    The ALLOWED_CONTROL_PLANE_HOSTS environment variable should contain
    a comma-separated list of allowed hostnames (with optional ports).

    Example: "open-inspect-control-plane-prod.myaccount.workers.dev,localhost:8787"

    Returns:
        Set of allowed host strings (lowercase)
    """
    hosts_str = os.environ.get("ALLOWED_CONTROL_PLANE_HOSTS", "")
    if not hosts_str:
        return set()
    return {h.strip().lower() for h in hosts_str.split(",") if h.strip()}


def validate_control_plane_url(url: str | None) -> bool:
    """
    Validate that a control_plane_url is allowed.

    Validation rules:
    1. Empty/None URLs are allowed (optional field)
    2. URL's host (including port) must be in ALLOWED_CONTROL_PLANE_HOSTS

    The ALLOWED_CONTROL_PLANE_HOSTS environment variable must be configured
    with the exact hostnames that are permitted. This is set via Modal secrets
    during deployment.

    Example ALLOWED_CONTROL_PLANE_HOSTS:
        "open-inspect-control-plane-prod.myaccount.workers.dev,localhost:8787"

    Args:
        url: The control plane URL to validate

    Returns:
        True if the URL is allowed, False otherwise
    """
    if not url:
        return True  # Empty URL is allowed (optional field)

    allowed_hosts = _get_allowed_hosts()

    if not allowed_hosts:
        # Fail closed: if no allowed hosts configured, reject all URLs
        # This ensures deployments must be properly configured
        log.warn("security.hosts_not_configured")
        return False

    try:
        parsed = urlparse(url)
        # Get host with port if present (e.g., "localhost:8787" or "example.com")
        host = parsed.netloc.lower()
        return host in allowed_hosts
    except Exception as e:
        log.warn("security.url_parse_error", exc=e)
        return False


# Volume for persistent storage (snapshot metadata, logs)
inspect_volume = modal.Volume.from_name("open-inspect-data", create_if_missing=True)
