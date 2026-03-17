"""Re-export GitHub App auth from sandbox-shared + GHES helper."""

import os

from sandbox_shared.auth.github_app import (  # noqa: F401
    generate_installation_token,
    generate_jwt,
    get_installation_token,
)


def resolve_api_base(hostname: str | None = None) -> str:
    """Resolve GitHub API base URL from a hostname (supports GHES).

    Args:
        hostname: e.g. "github.com" or "github.example.com". Reads
                  GITHUB_HOSTNAME env var as fallback. Defaults to github.com.

    Returns:
        API base URL without trailing slash.
    """
    host = (hostname or os.environ.get("GITHUB_HOSTNAME", "github.com")).lower().rstrip("/")
    if host == "github.com":
        return "https://api.github.com"
    return f"https://{host}/api/v3"
