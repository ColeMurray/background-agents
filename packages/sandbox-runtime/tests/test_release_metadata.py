import json
from pathlib import Path

from sandbox_runtime.release import (
    MANAGED_RUNTIME_VERSION,
    MIN_COMPATIBLE_RUNTIME_VERSION,
    OPENCODE_VERSION,
)


def test_release_metadata_is_valid() -> None:
    release_path = Path(__file__).parents[1] / "src" / "sandbox_runtime" / "release.json"
    release = json.loads(release_path.read_text())

    version_parts = release["opencode_version"].split(".")
    assert len(version_parts) == 3
    assert all(part.isdigit() for part in version_parts)
    assert release["managed_runtime_version"] >= release["minimum_compatible_runtime_version"] > 0
    assert release["opencode_version"] == OPENCODE_VERSION
    assert release["managed_runtime_version"] == MANAGED_RUNTIME_VERSION
    assert release["minimum_compatible_runtime_version"] == MIN_COMPATIBLE_RUNTIME_VERSION
