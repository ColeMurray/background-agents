import json
import re
from pathlib import Path

from sandbox_runtime.release import (
    MANAGED_RUNTIME_VERSION,
    MANAGED_SANDBOX_VERSION,
    MIN_COMPATIBLE_RUNTIME_VERSION,
    OPENCODE_VERSION,
)


def test_release_metadata_is_valid() -> None:
    release_path = Path(__file__).parents[1] / "src" / "sandbox_runtime" / "release.json"
    release = json.loads(release_path.read_text())

    assert re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", release["opencode_version"])
    assert release["managed_runtime_version"] >= release["minimum_compatible_runtime_version"] > 0
    expected_sandbox_version = (
        f"v{release['managed_runtime_version']}-opencode-"
        f"{release['opencode_version'].replace('.', '-')}"
    )
    assert release["managed_sandbox_version"] == expected_sandbox_version
    assert release["opencode_version"] == OPENCODE_VERSION
    assert release["managed_runtime_version"] == MANAGED_RUNTIME_VERSION
    assert release["minimum_compatible_runtime_version"] == MIN_COMPATIBLE_RUNTIME_VERSION
    assert release["managed_sandbox_version"] == MANAGED_SANDBOX_VERSION
