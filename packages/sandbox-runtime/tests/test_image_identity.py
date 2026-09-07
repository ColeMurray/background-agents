"""Runtime evidence belongs to the installed image, not launch-time labels."""

import json
from pathlib import Path

from sandbox_runtime.image_identity import read_image_identity, read_runtime_version
from sandbox_runtime.runtime_manifest import RUNTIME_VERSION


def test_legacy_image_reports_its_installed_manifest_not_injected_version(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("SANDBOX_VERSION", "v999-new-default")
    assert read_runtime_version(tmp_path / "absent.json") == RUNTIME_VERSION


def test_baked_identity_is_validated_and_reported(tmp_path: Path) -> None:
    path = tmp_path / "image.json"
    identity = {
        "schemaVersion": 1,
        "target": "e2b",
        "runtimeVersion": RUNTIME_VERSION,
        "recipeDigest": "a" * 64,
        "inventoryDigest": "b" * 64,
    }
    path.write_text(json.dumps(identity))
    assert read_image_identity(path) == identity
    assert read_runtime_version(path) == RUNTIME_VERSION
