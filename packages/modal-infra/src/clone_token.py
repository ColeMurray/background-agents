"""Resolve VCS clone tokens for Modal sandbox git operations."""

import os

from .log_config import get_logger

log = get_logger("clone_token")


def resolve_clone_token() -> str | None:
    """Return a provider-specific clone token, or None when credentials are unavailable."""
    from .auth import generate_installation_token

    scm_provider = os.environ.get("SCM_PROVIDER", "github")

    if scm_provider == "gitlab":
        token = os.environ.get("GITLAB_ACCESS_TOKEN")
        if not token:
            log.warn("gitlab.token_missing")
        return token

    try:
        app_id = os.environ.get("GITHUB_APP_ID")
        private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
        installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

        if app_id and private_key and installation_id:
            return generate_installation_token(
                app_id=app_id,
                private_key=private_key,
                installation_id=installation_id,
            )
    except Exception as e:
        log.warn("github.token_error", exc=e)

    return None
