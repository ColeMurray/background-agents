"""GitHub App token generation for sandbox git operations."""

from __future__ import annotations

import os
import time

import httpx
import jwt

GITHUB_INSTALLATION_TOKEN_TIMEOUT_SECONDS = 30.0


def generate_installation_token() -> str:
    """Generate a GitHub App installation token from environment variables."""
    app_id = os.environ["GITHUB_APP_ID"]
    private_key = os.environ["GITHUB_APP_PRIVATE_KEY"]
    installation_id = os.environ["GITHUB_APP_INSTALLATION_ID"]

    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + 600,
        "iss": app_id,
    }
    jwt_token = jwt.encode(payload, private_key, algorithm="RS256")

    response = httpx.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={
            "Authorization": f"Bearer {jwt_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=GITHUB_INSTALLATION_TOKEN_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.json()["token"]
