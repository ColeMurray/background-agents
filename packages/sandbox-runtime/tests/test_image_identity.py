"""Runtime evidence belongs to the installed image, not launch-time labels."""

import json
import os
from pathlib import Path

import pytest

from sandbox_runtime.image_identity import (
    apply_image_environment,
    read_image_identity,
    read_runtime_version,
)
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


def test_legacy_launch_environment_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("VIRTUAL_ENV", "/home/sandbox/.venv")
    before = dict(os.environ)
    apply_image_environment(tmp_path / "absent.json")
    assert dict(os.environ) == before


@pytest.mark.parametrize("home", ["/home/user", "/home/retained-artifact-user"])
def test_artifact_owns_launch_paths_without_activating_supervisor_venv(tmp_path, monkeypatch, home):
    monkeypatch.setenv("HOME", "/wrong-worker-default")
    monkeypatch.setenv("PATH", "/wrong-worker-path")
    monkeypatch.setenv("VIRTUAL_ENV", "/home/sandbox/.venv")
    monkeypatch.setenv("SANDBOX_TOKEN", "session-token")
    path = tmp_path / "image.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "target": "e2b",
                "runtimeVersion": RUNTIME_VERSION,
                "recipeDigest": "a" * 64,
                "inventoryDigest": "b" * 64,
                "runtimeEnv": {"HOME": home, "PATH": f"{home}/.local/bin:/usr/bin"},
            }
        )
    )
    apply_image_environment(path)
    assert os.environ["HOME"] == home
    assert os.environ["PATH"] == f"{home}/.local/bin:/usr/bin"
    assert "VIRTUAL_ENV" not in os.environ
    assert os.environ["SANDBOX_TOKEN"] == "session-token"
