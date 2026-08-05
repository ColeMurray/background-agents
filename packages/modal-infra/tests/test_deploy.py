"""Deployment contract tests for the Modal sandbox image."""

import os
import subprocess
from pathlib import Path
from unittest.mock import Mock

import deploy


def test_build_sandbox_image_eagerly_builds_against_deployed_app(monkeypatch) -> None:
    deployed_app = object()
    lookup = Mock(return_value=deployed_app)
    build = Mock()

    monkeypatch.setattr(deploy.modal.App, "lookup", lookup)
    monkeypatch.setattr(deploy, "base_image", Mock(build=build))

    deploy.build_sandbox_image()

    lookup.assert_called_once_with(deploy.app.name, create_if_missing=True)
    build.assert_called_once_with(deployed_app)


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


def test_modal_deployment_hash_includes_deployment_entrypoints() -> None:
    modal_tf = (
        Path(__file__).parents[3] / "terraform/environments/production/modal.tf"
    ).read_text()

    assert "packages/modal-infra/deploy.py" in modal_tf
    assert "terraform/modules/modal-app/scripts/deploy.sh" in modal_tf
