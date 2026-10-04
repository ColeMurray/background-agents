"""SCM credential environment shared by interactive and build sandboxes."""


def inject_vcs_env_vars(
    env_vars: dict[str, str],
    *,
    clone_host: str,
    clone_username: str,
    clone_token: str | None = None,
) -> None:
    """Inject the control plane's VCS identity and optional one-shot clone token."""
    env_vars["VCS_HOST"] = clone_host
    env_vars["VCS_CLONE_USERNAME"] = clone_username
    if clone_token:
        env_vars["VCS_CLONE_TOKEN"] = clone_token
