"""
Main Modal application definition for Open-Inspect.

This module defines the Modal app and shared resources used across
all sandbox operations.
"""

import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse

import modal
from modal.exception import NotFoundError

import sandbox_runtime

from .log_config import get_logger

# Path to sandbox_runtime source — bundled into function_image so shims can resolve
_SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent

log = get_logger("app")

# Main Modal application
app = modal.App("open-inspect")

# Image for Modal functions (not sandbox)
# Includes all dependencies needed by the function modules at import time
function_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "pydantic>=2.0",
        "httpx",
        "fastapi",
        "modal",  # Required for sandbox.manager imports
        "PyJWT[crypto]",  # For GitHub App token generation
    )
    # Bundle sandbox_runtime so modal-infra shims can import from it at runtime
    .add_local_dir(str(_SANDBOX_RUNTIME_DIR), remote_path="/root/sandbox_runtime")
)

# Deployment-wide LLM API keys, injected into sandboxes but never stored in
# snapshots. The secret is optional and holds whichever providers the deployment
# configured: sandboxes can equally get their model credentials from the control
# plane's secret store, so a deployment that uses only that store never creates
# this secret at all.
LLM_SECRET_NAME = "llm-api-keys"

_llm_secret = modal.Secret.from_name(LLM_SECRET_NAME)
_llm_secret_lock = asyncio.Lock()
_llm_secret_absent = False


async def llm_secrets() -> list[modal.Secret]:
    """Deployment-wide LLM keys, or nothing when the secret is not configured.

    The result splices straight into a `secrets=` argument. Resolution happens at
    most once per container: `hydrate` short-circuits on an already-hydrated
    secret, and an absent one is remembered so later launches skip the lookup.
    """
    global _llm_secret_absent

    async with _llm_secret_lock:
        if _llm_secret_absent:
            return []
        try:
            await _llm_secret.hydrate.aio()
        except NotFoundError:
            log.info("llm_secrets.not_configured", secret=LLM_SECRET_NAME)
            _llm_secret_absent = True
            return []

    return [_llm_secret]


# Secrets for GitHub App - used for git operations (clone, push)
# These are used to generate installation tokens, NOT injected into sandboxes
github_app_secrets = modal.Secret.from_name(
    "github-app",
    required_keys=["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"],
)

# Secret for internal API authentication and deployment configuration.
# Required keys:
#   MODAL_API_SECRET: verify requests from control plane to Modal endpoints
# Optional keys (add to the same secret as needed):
#   ALLOWED_CONTROL_PLANE_HOSTS: comma-separated list of permitted callback hosts
#   SCM_PROVIDER: "github" (default) or "gitlab" — selects the clone credential type
#   GITLAB_ACCESS_TOKEN: GitLab PAT used as clone credential when SCM_PROVIDER=gitlab
internal_api_secret = modal.Secret.from_name(
    "internal-api",
    required_keys=["MODAL_API_SECRET"],
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
