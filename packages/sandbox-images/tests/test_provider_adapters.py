"""Native retries verify retained artifacts without rebuilding or publishing failures."""

import runpy
import sys
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace
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


@pytest.mark.parametrize("failed", [False, True])
@pytest.mark.parametrize("retained", [False, True])
def test_daytona_retry_never_recreates_existing_snapshot(
    monkeypatch, build_mocks, failed, retained
):
    client = Mock()
    if not retained:
        client.snapshot.get.side_effect = FileNotFoundError("not found")
    sandbox = Mock()
    sandbox.process.exec.return_value = SimpleNamespace(exit_code=1 if failed else 0, result="")
    client.create.return_value = sandbox
    sandbox_params = Mock()
    monkeypatch.setitem(
        sys.modules,
        "daytona",
        SimpleNamespace(
            Daytona=Mock(return_value=client),
            DaytonaConfig=Mock(),
            CreateSandboxFromSnapshotParams=sandbox_params,
            DaytonaNotFoundError=FileNotFoundError,
        ),
    )
    package = ModuleType("test_daytona")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "test_daytona", package)
    monkeypatch.setitem(
        sys.modules,
        "test_daytona.config",
        SimpleNamespace(
            load_config=lambda: SimpleNamespace(
                repo_root=ROOT,
                base_snapshot="prefix",
                api_key="test",
                api_url="test",
                target="test",
            )
        ),
    )
    create = Mock()
    monkeypatch.setitem(
        sys.modules, "test_daytona.toolchain", SimpleNamespace(create_base_snapshot=create)
    )
    main = runpy.run_path(
        str(ROOT / "packages/daytona-infra/src/bootstrap.py"), run_name="test_daytona.bootstrap"
    )["main"]
    if failed:
        with pytest.raises(RuntimeError, match="verification failed"):
            main()
        build_mocks.assert_not_called()
    else:
        main()
        build_mocks.assert_called_once_with(EXPECTED_NAME)
    client.snapshot.get.assert_called_once_with(EXPECTED_NAME)
    assert create.call_count == (0 if retained else 1)
    if not retained:
        create.assert_called_once_with(client, bundle.pack_bundle.return_value, EXPECTED_NAME)
    assert not bundle.pack_bundle.return_value.directory.exists()
    assert sandbox_params.call_args.kwargs["env_vars"] is PLAN["runtimeEnv"]
    assert sandbox.process.exec.call_args.args[0].endswith("/app/verify/smoke_test.py verify")
    sandbox.delete.assert_called_once()


def test_daytona_image_uses_packed_bundle_plan(monkeypatch, tmp_path):
    image = Mock()
    for method in ("add_local_dir", "run_commands", "env", "workdir"):
        getattr(image, method).return_value = image
    image_class = Mock()
    image_class.base.return_value = image
    monkeypatch.setitem(
        sys.modules,
        "daytona",
        SimpleNamespace(CreateSnapshotParams=Mock(), Daytona=Mock(), Image=image_class),
    )
    build_base_image = runpy.run_path(str(ROOT / "packages/daytona-infra/src/toolchain.py"))[
        "build_base_image"
    ]

    packed = bundle.PackedBundle(tmp_path, PLAN)
    assert build_base_image(packed) is image
    image_class.base.assert_called_once_with("test-base")
    image.add_local_dir.assert_called_once_with(str(tmp_path), "/tmp/openinspect-image")
    image.env.assert_called_once_with({"PACKED_PLAN": "true", "SANDBOX_VERSION": "test-runtime"})
