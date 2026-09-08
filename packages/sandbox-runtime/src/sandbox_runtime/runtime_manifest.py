"""Validated sandbox runtime compatibility manifest."""

import json
import re
from pathlib import Path
from typing import TypedDict, cast


class RuntimeManifest(TypedDict):
    runtimeVersion: str
    generation: int
    minimumCompatibleGeneration: int
    minimumRebuildGeneration: int


_MANIFEST_PATH = Path(__file__).with_name("runtime_manifest.json")
RUNTIME_MANIFEST = cast("RuntimeManifest", json.loads(_MANIFEST_PATH.read_text()))
RUNTIME_VERSION = RUNTIME_MANIFEST["runtimeVersion"]
_VERSION_MATCH = re.match(r"^v(\d+)", RUNTIME_VERSION)

if not _VERSION_MATCH or int(_VERSION_MATCH.group(1)) != RUNTIME_MANIFEST["generation"]:
    raise RuntimeError("Sandbox runtime manifest version and generation disagree")
