"""Deployment contract tests for the Modal sandbox image."""

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import deploy
import pytest


def test_deployment_rejects_missing_image_without_opt_in(monkeypatch, tmp_path) -> None:
    from src.images import base

    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "image_reference_path", lambda: tmp_path / "missing.json")
    monkeypatch.delenv("OPENINSPECT_REQUIRE_BUILT_IMAGE", raising=False)

    with pytest.raises(RuntimeError, match="Build the Modal sandbox image"):
        base.deployed_image_environment()


@pytest.mark.parametrize(
    ("recipe", "image_id", "error"),
    [
        ("old-recipe", "im-built", "stale"),
        ("current-recipe", "", "missing its verified"),
        ("current-recipe", None, "missing its verified"),
    ],
)
def test_deployment_rejects_invalid_record_without_opt_in(
    monkeypatch, tmp_path, recipe, image_id, error
) -> None:
    from src.images import base

    record_path = tmp_path / "built.json"
    record_path.write_text(json.dumps({"buildHash": recipe, "imageId": image_id}))
    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "image_reference_path", lambda: record_path)
    monkeypatch.setattr(
        base, "local_image_plan", lambda: (tmp_path, {"buildHash": "current-recipe"})
    )
    monkeypatch.delenv("OPENINSPECT_REQUIRE_BUILT_IMAGE", raising=False)

    with pytest.raises(RuntimeError, match=error):
        base.deployed_image_environment()


def test_deployment_uses_matching_verified_record(monkeypatch, tmp_path) -> None:
    from src.images import base

    record_path = tmp_path / "built.json"
    record_path.write_text(json.dumps({"buildHash": "current-recipe", "imageId": "im-built"}))
    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "image_reference_path", lambda: record_path)
    monkeypatch.setattr(
        base, "local_image_plan", lambda: (tmp_path, {"buildHash": "current-recipe"})
    )

    assert base.deployed_image_environment() == {base.IMAGE_ID_ENV: "im-built"}


@pytest.mark.parametrize("image_id", [None, "im-deployed"])
def test_deployed_environment_requires_image_reference(monkeypatch, image_id) -> None:
    from src.images import base

    monkeypatch.setattr(base.modal, "is_local", lambda: False)
    monkeypatch.delenv(base.IMAGE_ID_ENV, raising=False)
    if image_id:
        monkeypatch.setenv(base.IMAGE_ID_ENV, image_id)
        assert base.deployed_image_environment() == {base.IMAGE_ID_ENV: image_id}
    else:
        with pytest.raises(RuntimeError, match="missing its verified"):
            base.deployed_image_environment()


def test_eager_build_does_not_register_functions_before_image_exists() -> None:
    environment = dict(os.environ)
    environment.pop("OPENINSPECT_MODAL_BASE_IMAGE_ID", None)
    environment["OPENINSPECT_REQUIRE_BUILT_IMAGE"] = "true"
    script = """
import runpy
import sys
from unittest.mock import patch
import modal

sys.argv = ['deploy.py', '--build-sandbox-image']
with patch.object(modal.App, 'lookup', side_effect=RuntimeError('image-build-entry')) as lookup:
    try:
        runpy.run_path('deploy.py', run_name='__main__')
    except RuntimeError as error:
        assert str(error) == 'image-build-entry', str(error)
    else:
        raise AssertionError('Eager image build was not entered')
    lookup.assert_called_once_with('open-inspect', create_if_missing=True)
assert 'src.app' not in sys.modules
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(deploy.__file__).parent,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_build_sandbox_image_eagerly_builds_against_deployed_app(monkeypatch, tmp_path) -> None:
    deployed_app = object()
    lookup = Mock(return_value=deployed_app)
    build = Mock()

    monkeypatch.setattr(deploy.modal.App, "lookup", lookup)
    monkeypatch.setattr(deploy, "base_image", Mock(build=build, object_id="im-verified"))
    process = Mock(returncode=0)
    process.stdout.read.return_value = ""
    sandbox = Mock()
    sandbox.exec.return_value = process
    monkeypatch.setattr(deploy.modal.Sandbox, "create", Mock(return_value=sandbox))
    monkeypatch.setattr(deploy, "image_reference_path", lambda: tmp_path / "selected.json")
    monkeypatch.setenv("OPENINSPECT_IMAGE_RESULT", str(tmp_path / "candidate.json"))

    deploy.build_sandbox_image()

    lookup.assert_called_once_with(deploy.app.name, create_if_missing=True)
    build.assert_called_once_with(deployed_app)
    sandbox.terminate.assert_called_once()
    assert json.loads((tmp_path / "selected.json").read_text())["imageId"] == "im-verified"


def _run_deploy_script(
    tmp_path: Path, *, deploy_module: str = "deploy", fail_eager_build: bool = False
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir = tmp_path / "bin"
    deploy_dir = tmp_path / "app"
    call_log = tmp_path / "uv-calls.log"
    bin_dir.mkdir()
    deploy_dir.mkdir()
    (deploy_dir / "pyproject.toml").touch()

    uv = bin_dir / "uv"
    uv.write_text(
        """#!/bin/sh
printf '%s\\n' "$*" >> "$UV_CALL_LOG"
if [ "${FAIL_EAGER_BUILD:-}" = "1" ] && [ "$*" = "run python deploy.py --build-sandbox-image" ]; then
    exit 42
fi
"""
    )
    uv.chmod(0o755)

    environment = os.environ | {
        "APP_NAME": "open-inspect",
        "DEPLOY_MODULE": deploy_module,
        "DEPLOY_PATH": str(deploy_dir),
        "FAIL_EAGER_BUILD": "1" if fail_eager_build else "0",
        "MODAL_ENVIRONMENT": "test",
        "MODAL_TOKEN_ID": "test-token-id",
        "MODAL_TOKEN_SECRET": "test-token-secret",
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "UV_CALL_LOG": str(call_log),
    }
    script = Path(__file__).parents[3] / "terraform/modules/modal-app/scripts/deploy.sh"
    result = subprocess.run(
        [str(script)],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
    )
    return result, call_log.read_text().splitlines()


def test_modal_deploy_script_builds_sandbox_image_before_app_deploy(tmp_path: Path) -> None:
    result, uv_calls = _run_deploy_script(tmp_path)

    assert result.returncode == 0
    assert uv_calls == [
        "sync --frozen",
        "run python deploy.py --build-sandbox-image",
        "run modal deploy deploy.py",
    ]


def test_modal_deploy_script_stops_when_eager_build_fails(tmp_path: Path) -> None:
    result, uv_calls = _run_deploy_script(tmp_path, fail_eager_build=True)

    assert result.returncode == 1
    assert uv_calls == [
        "sync --frozen",
        "run python deploy.py --build-sandbox-image",
    ]


def test_src_modal_deploy_builds_sandbox_image_before_app_deploy(tmp_path: Path) -> None:
    result, uv_calls = _run_deploy_script(tmp_path, deploy_module="src")

    assert result.returncode == 0
    assert uv_calls == [
        "sync --frozen",
        "run python deploy.py --build-sandbox-image",
        "run modal deploy -m src",
    ]
