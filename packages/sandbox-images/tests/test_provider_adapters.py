"""Native retries verify retained artifacts without rebuilding or publishing failures."""

import json
import runpy
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sandbox_images import bundle, native

ROOT = Path(__file__).parents[3]
PLAN = {
    "provider": "e2b",
    "buildHash": "a" * 64,
    "runtimeEnv": {"PACKED_PLAN": "true"},
    "runtimeVersion": "test-runtime",
    "target": {
        "os": "debian",
        "base": "test-base",
        "node": "22",
        "user": "test-user",
        "home": "/home/test-user",
    },
}
EXPECTED_NAME = "prefix-aaaaaaaaaaaa-123"


@pytest.fixture
def build_mocks(monkeypatch, tmp_path):
    bundle_directory = tmp_path / "bundle"
    bundle_directory.mkdir()
    monkeypatch.setattr(
        bundle, "plan_image", Mock(side_effect=AssertionError("provider replanned image"))
    )
    monkeypatch.setattr(
        bundle,
        "pack_bundle",
        Mock(return_value=bundle.PackedBundle(bundle_directory, PLAN)),
    )
    publish = Mock()
    monkeypatch.setattr(native, "write_build_result", publish)
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    monkeypatch.setattr(time, "time_ns", lambda: 123)
    return publish


@pytest.mark.parametrize("failed", [False, True])
@pytest.mark.parametrize("retained", [False, True])
def test_e2b_retry_never_overwrites_existing_template(monkeypatch, build_mocks, failed, retained):
    monkeypatch.setenv("E2B_API_KEY", "test")
    monkeypatch.setenv("E2B_TEMPLATE_ID", "prefix")
    template = Mock()
    for name in ("from_dockerfile", "copy", "run_cmd", "set_user", "set_workdir", "set_start_cmd"):
        getattr(template, name).return_value = template
    template_class = Mock(return_value=template)
    template_class.exists.return_value = retained
    template_class.build.return_value = SimpleNamespace(template_id=EXPECTED_NAME)
    sandbox = Mock()
    sandbox.commands.run.return_value = SimpleNamespace(exit_code=1 if failed else 0, stdout="")
    sandbox_class = Mock()
    sandbox_class.create.return_value = sandbox
    monkeypatch.setitem(
        sys.modules,
        "e2b",
        SimpleNamespace(
            Sandbox=sandbox_class, Template=template_class, default_build_logger=Mock()
        ),
    )
    main = runpy.run_path(str(ROOT / "packages/e2b-infra/build-template.py"))["main"]
    if failed:
        with pytest.raises(RuntimeError, match="verification failed"):
            main()
        build_mocks.assert_not_called()
    else:
        main()
        build_mocks.assert_called_once_with(EXPECTED_NAME)
    assert template_class.build.call_count == (0 if retained else 1)
    assert (
        template_class.call_args.kwargs["file_context_path"]
        == bundle.pack_bundle.return_value.directory
    )
    template.from_dockerfile.assert_called_once_with("FROM test-base")
    template.set_user.assert_called_once_with("test-user")
    assert sandbox_class.create.call_args.kwargs["template"] == EXPECTED_NAME
    assert sandbox_class.create.call_args.kwargs["envs"] is PLAN["runtimeEnv"]
    assert sandbox.commands.run.call_args.args[0].endswith("/app/verify/smoke_test.py verify")
    sandbox.kill.assert_called_once()


def test_daytona_config_requires_registry_repository(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "test")
    monkeypatch.delenv("DAYTONA_IMAGE_REPOSITORY", raising=False)
    load_config = runpy.run_path(str(ROOT / "packages/daytona-infra/src/config.py"))["load_config"]

    with pytest.raises(RuntimeError, match="DAYTONA_IMAGE_REPOSITORY is required"):
        load_config()


def load_daytona_toolchain(monkeypatch):
    params = Mock(side_effect=lambda **values: SimpleNamespace(**values))
    resources = Mock(side_effect=lambda **values: SimpleNamespace(**values))
    monkeypatch.setitem(
        sys.modules,
        "daytona",
        SimpleNamespace(
            CreateSandboxFromImageParams=params,
            Daytona=object,
            DaytonaNotFoundError=FileNotFoundError,
            Resources=resources,
        ),
    )
    module = runpy.run_path(str(ROOT / "packages/daytona-infra/src/toolchain.py"))
    return module, params, resources


def test_daytona_publish_uses_exact_buildx_metadata_digest(monkeypatch, tmp_path):
    module, _, _ = load_daytona_toolchain(monkeypatch)
    packed = bundle.PackedBundle(tmp_path, PLAN)

    def run(command, **kwargs):
        metadata = command[command.index("--metadata-file") + 1]
        Path(metadata).write_text(json.dumps({"containerimage.digest": "sha256:" + "b" * 64}))
        assert command[-1] == str(tmp_path)
        assert command[command.index("--target") + 1] == "daytona-runtime"
        assert "--push" in command
        assert "OI_ENV_PACKED_PLAN=true" in command
        return SimpleNamespace(returncode=0)

    reference = module["publish_image"](
        packed, "ghcr.io/example/open-inspect-daytona", "candidate-1", run=run
    )
    assert reference == "ghcr.io/example/open-inspect-daytona@sha256:" + "b" * 64


def test_daytona_publish_failure_never_returns_reference(monkeypatch, tmp_path):
    module, _, _ = load_daytona_toolchain(monkeypatch)
    packed = bundle.PackedBundle(tmp_path, PLAN)
    failed_run = Mock(side_effect=subprocess.CalledProcessError(1, ["docker", "buildx"]))

    with pytest.raises(subprocess.CalledProcessError):
        module["publish_image"](
            packed, "private.example.com/team/open-inspect", "candidate-1", run=failed_run
        )


def test_daytona_create_failure_is_preserved_when_probe_is_absent(monkeypatch):
    module, _, _ = load_daytona_toolchain(monkeypatch)
    client = SimpleNamespace(
        create=Mock(side_effect=RuntimeError("registry pull denied")),
        get=Mock(side_effect=FileNotFoundError("not found")),
        delete=Mock(),
    )

    with pytest.raises(RuntimeError, match="registry pull denied"):
        module["verify_image"](client, "private.example.com/team/image@sha256:" + "c" * 64, 2)

    client.get.assert_called_once()
    client.delete.assert_not_called()


@pytest.mark.parametrize("failed", [False, True])
def test_daytona_native_verification_allocation_and_cleanup(monkeypatch, failed):
    module, params, resources = load_daytona_toolchain(monkeypatch)
    sandbox = SimpleNamespace(
        cpu=1,
        memory=4,
        process=SimpleNamespace(
            exec=Mock(return_value=SimpleNamespace(exit_code=1 if failed else 0, result="failure"))
        ),
    )
    client = SimpleNamespace(create=Mock(return_value=sandbox), get=Mock(), delete=Mock())

    if failed:
        with pytest.raises(RuntimeError, match="verification failed"):
            module["verify_image"](client, "ghcr.io/example/image@sha256:" + "c" * 64, 4)
    else:
        module["verify_image"](client, "ghcr.io/example/image@sha256:" + "c" * 64, 4)

    resources.assert_called_once_with(cpu=1, memory=4)
    assert params.call_args.kwargs["env_vars"] == {"OI_DEFERRED_START": "true"}
    assert params.call_args.kwargs["ttl_minutes"] == 10
    client.delete.assert_called_once_with(sandbox, timeout=30)
