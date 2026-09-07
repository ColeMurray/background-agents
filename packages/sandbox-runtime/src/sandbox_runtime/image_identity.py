"""Read compatibility evidence from installed files, never deployment defaults."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from sandbox_runtime.runtime_manifest import RUNTIME_VERSION

IMAGE_IDENTITY_PATH = Path("/app/openinspect-image.json")

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


def apply_image_environment(path: Path = IMAGE_IDENTITY_PATH) -> None:
    """Apply this artifact's launch contract, leaving legacy images untouched."""
    identity = read_image_identity(path)
    if identity is None:
        return
    environment = identity.get("runtimeEnv")
    if not isinstance(environment, dict) or any(
        key not in IMAGE_ENV_KEYS or not isinstance(value, str)
        for key, value in environment.items()
    ):
        raise RuntimeError("Invalid baked image runtime environment")
    # The supervisor interpreter is private infrastructure, not a project venv.
    os.environ.pop("VIRTUAL_ENV", None)
    os.environ.update(environment)


def read_image_identity(path: Path = IMAGE_IDENTITY_PATH) -> dict[str, Any] | None:
    try:
        identity = json.loads(path.read_text())
    except FileNotFoundError:
        return None  # Legacy images still carry their own runtime manifest.
    if not isinstance(identity, dict) or identity.get("schemaVersion") != 1:
        raise RuntimeError("Invalid baked image identity schema")
    if identity.get("target") not in {"modal", "daytona", "e2b", "vercel", "opencomputer"}:
        raise RuntimeError("Invalid baked image target")
    for key in ("recipeDigest", "inventoryDigest"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(identity.get(key, ""))):
            raise RuntimeError(f"Invalid baked image {key}")
    if identity.get("runtimeVersion") != RUNTIME_VERSION:
        raise RuntimeError("Baked image and installed runtime manifest disagree")
    return identity


def read_runtime_version(path: Path = IMAGE_IDENTITY_PATH) -> str:
    read_image_identity(path)
    return RUNTIME_VERSION
