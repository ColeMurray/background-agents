"""Read compatibility evidence from installed files, never deployment defaults."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sandbox_runtime.runtime_manifest import RUNTIME_VERSION

IMAGE_IDENTITY_PATH = Path("/app/openinspect-image.json")


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
