"""Apply launch paths baked into this artifact, independent of Worker defaults."""

from __future__ import annotations

import json
import os
from pathlib import Path

IMAGE_ENVIRONMENT_PATH = Path("/app/openinspect-runtime-environment.json")

# Only build-owned launch paths may overlay session configuration and secrets.
IMAGE_ENV_KEYS = frozenset(
    {
        "HOME",
        "XDG_CONFIG_HOME",
        "NODE_ENV",
        "PYTHONPATH",
        "NODE_PATH",
        "PATH",
        "npm_config_prefix",
        "npm_config_cache",
        "PNPM_HOME",
        "OPENINSPECT_BIN_INSTALL_DIR",
        "OI_SCM_CRED_CACHE_DIR",
    }
)


def apply_image_environment(path: Path = IMAGE_ENVIRONMENT_PATH) -> None:
    try:
        environment = json.loads(path.read_text())
    except FileNotFoundError:
        return  # Legacy artifacts keep their existing launch environment.
    if not isinstance(environment, dict) or any(
        key not in IMAGE_ENV_KEYS or not isinstance(value, str)
        for key, value in environment.items()
    ):
        raise RuntimeError("Invalid baked image runtime environment")
    # The supervisor interpreter is private infrastructure, not a project venv.
    os.environ.pop("VIRTUAL_ENV", None)
    os.environ.update(environment)
