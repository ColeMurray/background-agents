import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from sandbox_images.bundle import canonical_json
from sandbox_images.releases import candidate_record, promote, rollback, validate_record


def record(reference: str, provider: str = "e2b") -> dict:
    inventory = {
        "schemaVersion": 1,
        "target": provider,
        "recipeDigest": "a" * 64,
        "runtimeVersion": "v62-test",
    }
    identity = inventory | {
        "inventoryDigest": hashlib.sha256(canonical_json(inventory).encode()).hexdigest()
    }
    return candidate_record(
        provider,
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


@pytest.mark.parametrize(
    "field,value",
    [
        ("provider", "unknown"),
        ("scope", ""),
        ("reference", ""),
        ("reference", " "),
    ],
)
def test_candidate_rejects_invalid_artifact_fields(field, value):
    candidate = record("template")
    candidate["artifact"][field] = value
    with pytest.raises(ValueError):
        validate_record(candidate)


@pytest.mark.parametrize(
    "field,value",
    [
        ("schemaVersion", 2),
        ("schemaVersion", True),
        ("runtimeVersion", None),
        ("runtimeVersion", ""),
        ("runtimeVersion", "invalid"),
        ("runtimeVersion", "v\u0661"),
        ("target", "unknown"),
        ("recipeDigest", None),
    ],
)
def test_invalid_identity_cannot_be_promoted(tmp_path, field, value):
    candidate = record("template")
    candidate["verification"]["identity"][field] = value
    with pytest.raises(ValueError):
        promote(tmp_path / "releases.json", candidate)
    assert not (tmp_path / "releases.json").exists()


def test_missing_runtime_version_is_rejected():
    candidate = record("template")
    del candidate["verification"]["identity"]["runtimeVersion"]
    with pytest.raises(ValueError, match="runtimeVersion"):
        validate_record(candidate)


def test_concurrent_provider_promotions_preserve_every_selection(tmp_path, monkeypatch):
    from sandbox_images import releases

    read_store = releases._read_store

    def slow_read(path):
        store = read_store(path)
        time.sleep(0.02)  # Expose the lost-update window in an unlocked RMW.
        return store

    monkeypatch.setattr(releases, "_read_store", slow_read)
    path = tmp_path / "releases.json"
    providers = ["modal", "daytona", "e2b", "vercel", "opencomputer"]
    rounds = [[record(f"artifact-{round}", p) for p in providers] for round in range(2)]
    for records in rounds:
        with ThreadPoolExecutor(max_workers=5) as executor:
            list(executor.map(lambda item: promote(path, item), records))
    store = json.loads(path.read_text())
    assert len(store["releases"]) == 10
    for index, provider in enumerate(providers):
        assert store["selected"][provider] == rounds[1][index]["baseReleaseId"]
        assert store["previous"][provider] == rounds[0][index]["baseReleaseId"]
