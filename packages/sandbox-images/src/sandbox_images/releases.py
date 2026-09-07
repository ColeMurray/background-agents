"""Non-secret candidate records; promotion is separate from native construction."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

from .bundle import canonical_json


def candidate_record(
    provider: str, scope: str, reference: str, report: dict[str, Any]
) -> dict[str, Any]:
    if report.get("passed") is not True or report.get("servicesVerified") is not True:
        raise ValueError("A release requires successful fresh-artifact service verification")
    identity = report["identity"]
    if identity["target"] != provider:
        raise ValueError("Verification target does not match provider")
    for key in ("recipeDigest", "inventoryDigest"):
        if not re.fullmatch(r"[a-f0-9]{64}", identity.get(key, "")):
            raise ValueError(f"Invalid image {key}")
    inventory = {key: value for key, value in identity.items() if key != "inventoryDigest"}
    if (
        hashlib.sha256(canonical_json(inventory).encode()).hexdigest()
        != identity["inventoryDigest"]
    ):
        raise ValueError("Verification inventory digest mismatch")
    artifact = {"provider": provider, "scope": scope, "reference": reference}
    release_id = hashlib.sha256(
        canonical_json(
            {"artifact": artifact, "inventoryDigest": identity["inventoryDigest"]}
        ).encode()
    ).hexdigest()
    return {
        "schemaVersion": 1,
        "baseReleaseId": release_id,
        "artifact": artifact,
        "identity": identity,
        "verification": report,
    }


def write_candidate(record: dict[str, Any]) -> None:
    output = os.environ.get("OPENINSPECT_IMAGE_RESULT")
    if output:
        path = Path(output)
        _write_json(path, record)
    else:
        print(json.dumps(record))


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(canonical_json(value) + "\n")
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_store(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schemaVersion": 1, "selected": {}, "previous": {}, "releases": {}}
    store = json.loads(path.read_text())
    if store.get("schemaVersion") != 1:
        raise ValueError("Unsupported release store schema")
    return store


def validate_record(record: dict[str, Any]) -> None:
    artifact = record["artifact"]
    expected = candidate_record(
        artifact["provider"], artifact["scope"], artifact["reference"], record["verification"]
    )
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError("Candidate record integrity check failed")


@contextmanager
def _store_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the inode stable: unlinking this sidecar would split waiting writers.
    with path.with_name(path.name + ".writer-lock").open("a") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def promote(path: Path, record: dict[str, Any]) -> None:
    """Serialize selection updates; never mutate provider artifacts."""
    path = path.resolve()
    with _store_lock(path):
        _promote(path, record)


def _promote(path: Path, record: dict[str, Any]) -> None:
    validate_record(record)
    store = _read_store(path)
    provider = record["artifact"]["provider"]
    release_id = record["baseReleaseId"]
    if release_id in store["releases"] and store["releases"][release_id] != record:
        raise ValueError("An immutable release record cannot be overwritten")
    current = store["selected"].get(provider)
    if current == release_id:
        return
    if current:
        if store["releases"][current]["artifact"]["scope"] != record["artifact"]["scope"]:
            raise ValueError("Cannot promote across provider accounts in one release store")
        store["previous"][provider] = current
    store["releases"][release_id] = record
    store["selected"][provider] = release_id
    _write_json(path, store)


def rollback(path: Path, provider: str) -> None:
    path = path.resolve()
    with _store_lock(path):
        store = _read_store(path)
        previous = store["previous"].get(provider)
        if not previous:
            raise ValueError(f"No previous release for {provider}")
        _promote(path, store["releases"][previous])
