"""Runtime release metadata shared by Python image builders."""

import json
from pathlib import Path
from typing import cast

_RELEASE = json.loads(Path(__file__).with_name("release.json").read_text())

OPENCODE_VERSION = cast("str", _RELEASE["opencode_version"])
MANAGED_RUNTIME_VERSION = cast("int", _RELEASE["managed_runtime_version"])
MIN_COMPATIBLE_RUNTIME_VERSION = cast("int", _RELEASE["minimum_compatible_runtime_version"])
