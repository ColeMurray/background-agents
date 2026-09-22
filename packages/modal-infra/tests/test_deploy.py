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
    plan = {
        "buildHash": "packed-recipe",
        "runtimeEnv": {"PACKED_PLAN": "true"},
    }

    monkeypatch.setattr(deploy.modal.App, "lookup", lookup)
    monkeypatch.setattr(deploy, "base_image", Mock(build=build, object_id="im-verified"))
    monkeypatch.setattr(deploy, "base_image_plan", plan)
    process = Mock(returncode=0)
    process.stdout.read.return_value = ""
    sandbox = Mock()
    sandbox.exec.return_value = process
    create = Mock(return_value=sandbox)
    monkeypatch.setattr(deploy.modal.Sandbox, "create", create)
    monkeypatch.setattr(deploy, "image_reference_path", lambda: tmp_path / "selected.json")
    monkeypatch.setenv("OPENINSPECT_IMAGE_RESULT", str(tmp_path / "candidate.json"))

    deploy.build_sandbox_image()

    lookup.assert_called_once_with(deploy.app.name, create_if_missing=True)
    build.assert_called_once_with(deployed_app)
    assert create.call_args.kwargs["env"] is plan["runtimeEnv"]
    sandbox.terminate.assert_called_once()
    assert json.loads((tmp_path / "selected.json").read_text()) == {
        "imageId": "im-verified",
        "buildHash": "packed-recipe",
    }


def test_local_base_image_retains_its_packed_plan(monkeypatch, tmp_path) -> None:
    from src.images import base

    plan = {
        "runtimeEnv": {"PACKED_PLAN": "true"},
        "runtimeVersion": "packed-runtime",
        "target": {"base": "packed-base"},
    }
    image = Mock()
    for method in ("add_local_dir", "run_commands", "env", "workdir"):
        getattr(image, method).return_value = image
    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "local_image_plan", lambda: (tmp_path, plan))
    monkeypatch.setattr(base.modal.Image, "from_registry", Mock(return_value=image))

    defined_image, defined_plan = base._define_image()

    assert defined_image is image
    assert defined_plan is plan
    image.env.assert_called_once_with({"PACKED_PLAN": "true", "SANDBOX_VERSION": "packed-runtime"})


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


def test_function_image_copies_runtime_before_later_build_steps() -> None:
    source = (Path(__file__).parents[1] / "src/app.py").read_text()
    add_runtime = source.index(".add_local_dir(")
    assert "copy=True" in source[add_runtime : source.index(".env(", add_runtime)]


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


def _verifying_sandbox(*, exit_codes: list[int]) -> Mock:
    sandbox = Mock()
    processes = []
    for code in exit_codes:
        process = Mock(returncode=code)
        process.stdout.read.return_value = ""
        process.stderr.read.return_value = "boom"
        processes.append(process)
    sandbox.exec.side_effect = processes
    return sandbox


@pytest.mark.parametrize("docker_verification_passes", [True, False])
def test_docker_image_is_built_and_verified_on_the_vm_after_the_default_is_published(
    monkeypatch, tmp_path, docker_verification_passes
) -> None:
    deployed_app = object()
    monkeypatch.setattr(deploy.modal.App, "lookup", Mock(return_value=deployed_app))
    monkeypatch.setattr(deploy, "base_image", Mock(build=Mock(), object_id="im-default"))
    docker_build = Mock()
    monkeypatch.setattr(deploy, "docker_image", Mock(build=docker_build, object_id="im-docker"))
    plan = {"buildHash": "packed-recipe", "runtimeEnv": {"PACKED_PLAN": "true"}}
    monkeypatch.setattr(deploy, "base_image_plan", plan)
    default_sandbox = _verifying_sandbox(exit_codes=[0])
    docker_sandbox = _verifying_sandbox(exit_codes=[0, 0 if docker_verification_passes else 1])
    create = Mock(side_effect=[default_sandbox, docker_sandbox])
    monkeypatch.setattr(deploy.modal.Sandbox, "create", create)
    record_path = tmp_path / "selected.json"
    monkeypatch.setattr(deploy, "image_reference_path", lambda: record_path)
    monkeypatch.setenv("OPENINSPECT_IMAGE_RESULT", str(tmp_path / "candidate.json"))

    if docker_verification_passes:
        deploy.build_sandbox_image(with_docker=True)
    else:
        with pytest.raises(RuntimeError, match="verification failed"):
            deploy.build_sandbox_image(with_docker=True)

    docker_build.assert_called_once_with(deployed_app)
    assert "experimental_options" not in create.call_args_list[0].kwargs
    vm_kwargs = create.call_args_list[1].kwargs
    assert vm_kwargs["experimental_options"] == {"vm_runtime": True}
    assert (vm_kwargs["cpu"], vm_kwargs["memory"]) == (2, 4096)
    assert [call.args[1] for call in docker_sandbox.exec.call_args_list] == [
        "/app/verify/smoke_test.py",
        "/app/verify/docker_smoke.py",
    ][: len(docker_sandbox.exec.call_args_list)]
    default_sandbox.terminate.assert_called_once()
    docker_sandbox.terminate.assert_called_once()
    record = json.loads(record_path.read_text())
    expected = {"imageId": "im-default", "buildHash": "packed-recipe"}
    if docker_verification_passes:
        expected["dockerImageId"] = "im-docker"
    # A failed Docker variant never disturbs the verified default reference.
    assert record == expected


def test_deployed_environment_carries_the_docker_image_when_provisioned(
    monkeypatch, tmp_path
) -> None:
    from src.images import base

    record_path = tmp_path / "built.json"
    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "image_reference_path", lambda: record_path)
    monkeypatch.setattr(
        base, "local_image_plan", lambda: (tmp_path, {"buildHash": "current-recipe"})
    )
    monkeypatch.delenv("BUILD_MODAL_VM_IMAGE", raising=False)

    record_path.write_text(json.dumps({"buildHash": "current-recipe", "imageId": "im-built"}))
    assert base.deployed_image_environment() == {base.IMAGE_ID_ENV: "im-built"}

    record_path.write_text(
        json.dumps(
            {"buildHash": "current-recipe", "imageId": "im-built", "dockerImageId": "im-docker"}
        )
    )
    assert base.deployed_image_environment() == {
        base.IMAGE_ID_ENV: "im-built",
        base.DOCKER_IMAGE_ID_ENV: "im-docker",
    }

    record_path.write_text(json.dumps({"buildHash": "current-recipe", "imageId": "im-built"}))
    monkeypatch.setenv("BUILD_MODAL_VM_IMAGE", "true")
    with pytest.raises(RuntimeError, match="Docker sandbox image"):
        base.deployed_image_environment()


def test_docker_image_is_absent_in_a_deployment_that_never_provisioned_it(monkeypatch) -> None:
    from src.images import base

    monkeypatch.setattr(base.modal, "is_local", lambda: False)
    monkeypatch.delenv(base.DOCKER_IMAGE_ID_ENV, raising=False)
    assert base._define_docker_image() is None

    monkeypatch.setenv(base.DOCKER_IMAGE_ID_ENV, "im-docker")
    monkeypatch.setattr(base.modal.Image, "from_id", Mock(return_value="docker-image"))
    assert base._define_docker_image() == "docker-image"


def test_local_docker_image_is_the_default_image_plus_the_docker_phase(monkeypatch) -> None:
    from src.images import base

    image = Mock()
    monkeypatch.setattr(base.modal, "is_local", lambda: True)
    monkeypatch.setattr(base, "base_image", image)

    base._define_docker_image()

    image.run_commands.assert_called_once_with(
        "bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh docker"
    )


def test_docker_verification_resources_match_backend_defaults() -> None:
    from src.sandbox.launch_policy import VM_DEFAULT_CPU_CORES, VM_DEFAULT_MEMORY_MIB

    assert deploy.DOCKER_VERIFICATION_CPU_CORES == VM_DEFAULT_CPU_CORES
    assert deploy.DOCKER_VERIFICATION_MEMORY_MIB == VM_DEFAULT_MEMORY_MIB
