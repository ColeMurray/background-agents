"""Port configuration shared by sandbox-hosted network services."""

import os


def port_from_env(env_var: str, default: int) -> int:
    """Read a valid TCP port override or return the service default."""
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default
