"""
GitHub App token generation for git operations.

Generates short-lived installation access tokens for:
- Cloning private repositories during image builds
- Git fetch/sync at sandbox startup
- Git push when creating pull requests

Supports both GitHub.com and GitHub Enterprise Server (GHES).
Set GITHUB_HOSTNAME env var to target a GHES instance.

Tokens are valid for ~1 hour.
"""

import os
import time

import httpx
import jwt


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


def generate_jwt(app_id: str, private_key: str) -> str:
    """
    Generate a JWT for GitHub App authentication.

    Args:
        app_id: The GitHub App's ID
        private_key: The App's private key (PEM format)

    Returns:
        Signed JWT valid for 10 minutes
    """
    now = int(time.time())
    payload = {
        "iat": now - 60,  # Issued 60 seconds ago (clock skew tolerance)
        "exp": now + 600,  # Expires in 10 minutes
        "iss": app_id,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


def get_installation_token(
    jwt_token: str,
    installation_id: str,
    api_base: str | None = None,
) -> str:
    """
    Exchange a JWT for an installation access token.

    Args:
        jwt_token: The signed JWT
        installation_id: The GitHub App installation ID
        api_base: GitHub API base URL (defaults via GITHUB_HOSTNAME env var)

    Returns:
        Installation access token (valid for 1 hour)

    Raises:
        httpx.HTTPStatusError: If the GitHub API request fails
    """
    base = api_base or resolve_api_base()
    url = f"{base}/app/installations/{installation_id}/access_tokens"
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    with httpx.Client() as client:
        response = client.post(url, headers=headers)
        response.raise_for_status()
        return response.json()["token"]


def generate_installation_token(
    app_id: str,
    private_key: str,
    installation_id: str,
    api_base: str | None = None,
) -> str:
    """
    Generate a fresh GitHub App installation token.

    This is the main entry point for token generation. It:
    1. Creates a JWT signed with the App's private key
    2. Exchanges it for an installation access token

    Args:
        app_id: The GitHub App's ID
        private_key: The App's private key (PEM format)
        installation_id: The GitHub App installation ID
        api_base: GitHub API base URL (defaults via GITHUB_HOSTNAME env var)

    Returns:
        Installation access token (valid for 1 hour)

    Raises:
        httpx.HTTPStatusError: If the GitHub API request fails
        jwt.PyJWTError: If JWT encoding fails
    """
    jwt_token = generate_jwt(app_id, private_key)
    return get_installation_token(jwt_token, installation_id, api_base)
