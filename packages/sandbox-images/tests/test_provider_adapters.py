"""Native retries verify retained artifacts without rebuilding or publishing failures."""

import runpy
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest

from sandbox_images import bundle, native

ROOT = Path(__file__).parents[3]
PLAN = {
    "buildHash": "a" * 64,
    "runtimeEnv": {},
    "target": {"base": "test-base"},
}


@pytest.fixture
def build_mocks(monkeypatch, tmp_path):
    monkeypatch.setattr(bundle, "plan_image", Mock(return_value=PLAN))
    monkeypatch.setattr(bundle, "pack_bundle", Mock(return_value=tmp_path))
    publish = Mock()
    monkeypatch.setattr(native, "write_build_result", publish)
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "retained-name")
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
    template_class.build.return_value = SimpleNamespace(template_id="retained-name")
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
        build_mocks.assert_called_once_with("retained-name")
    assert template_class.build.call_count == (0 if retained else 1)
    assert sandbox_class.create.call_args.kwargs["template"] == "retained-name"
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
    monkeypatch.setitem(
        sys.modules,
        "daytona",
        SimpleNamespace(
            Daytona=Mock(return_value=client),
            DaytonaConfig=Mock(),
            CreateSandboxFromSnapshotParams=Mock(),
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
        build_mocks.assert_called_once_with("retained-name")
    client.snapshot.get.assert_called_once_with("retained-name")
    assert create.call_count == (0 if retained else 1)
    assert sandbox.process.exec.call_args.args[0].endswith("/app/verify/smoke_test.py verify")
    sandbox.delete.assert_called_once()
