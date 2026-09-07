import hashlib
import json
from pathlib import Path

import pytest

from sandbox_images.bundle import canonical_json
from sandbox_images.releases import candidate_record, promote, rollback


def record(reference: str) -> dict:
    inventory = {
        "schemaVersion": 1,
        "target": "e2b",
        "recipeDigest": "a" * 64,
        "runtimeVersion": "v62-test",
    }
    identity = inventory | {
        "inventoryDigest": hashlib.sha256(canonical_json(inventory).encode()).hexdigest()
    }
    return candidate_record(
        "e2b",
        "test-account",
        reference,
        {"passed": True, "servicesVerified": True, "identity": identity},
    )


def test_promotion_and_rollback_preserve_immutable_release_history(tmp_path: Path) -> None:
    path = tmp_path / "releases.json"
    first, second = record("template-1"), record("template-2")
    promote(path, first)
    promote(path, second)
    selected = json.loads(path.read_text())
    assert selected["selected"]["e2b"] == second["baseReleaseId"]
    assert selected["previous"]["e2b"] == first["baseReleaseId"]
    rollback(path, "e2b")
    rolled_back = json.loads(path.read_text())
    assert rolled_back["selected"]["e2b"] == first["baseReleaseId"]
    assert len(rolled_back["releases"]) == 2


def test_failed_verification_cannot_be_a_candidate() -> None:
    with pytest.raises(ValueError, match="verification"):
        candidate_record("e2b", "test", "template-1", {"passed": False})
