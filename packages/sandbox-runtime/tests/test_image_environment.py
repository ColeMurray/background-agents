"""Launch configuration belongs to the installed image, not the Worker."""

import json
import os

import pytest

from sandbox_runtime.image_environment import apply_image_environment


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
                "HOME": home,
                "PATH": f"{home}/.local/bin:/usr/bin",
            }
        )
    )
    apply_image_environment(path)
    assert os.environ["HOME"] == home
    assert os.environ["PATH"] == f"{home}/.local/bin:/usr/bin"
    assert "VIRTUAL_ENV" not in os.environ
    assert os.environ["SANDBOX_TOKEN"] == "session-token"


@pytest.mark.parametrize("environment", [{"SANDBOX_TOKEN": "override"}, {"PATH": 42}, []])
def test_rejects_invalid_or_session_owned_environment(tmp_path, environment):
    path = tmp_path / "environment.json"
    path.write_text(json.dumps(environment))
    before = dict(os.environ)
    with pytest.raises(RuntimeError, match="Invalid baked"):
        apply_image_environment(path)
    assert dict(os.environ) == before
