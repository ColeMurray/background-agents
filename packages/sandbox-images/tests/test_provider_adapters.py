"""Native retries verify retained artifacts without rebuilding or publishing failures."""

import runpy
import subprocess
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
        "node": "24",
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
                base_snapshot_memory_gib=2,
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
        create.assert_called_once_with(client, bundle.pack_bundle.return_value, EXPECTED_NAME, 2)
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
        SimpleNamespace(
            CreateSnapshotParams=Mock(), Daytona=Mock(), Image=image_class, Resources=Mock()
        ),
    )
    build_base_image = runpy.run_path(str(ROOT / "packages/daytona-infra/src/toolchain.py"))[
        "build_base_image"
    ]

    packed = bundle.PackedBundle(tmp_path, PLAN)
    assert build_base_image(packed) is image
    image_class.base.assert_called_once_with("test-base")
    image.add_local_dir.assert_called_once_with(str(tmp_path), "/tmp/openinspect-image")
    image.env.assert_called_once_with({"PACKED_PLAN": "true", "SANDBOX_VERSION": "test-runtime"})


def test_daytona_snapshot_uses_configured_memory(monkeypatch, tmp_path):
    image = Mock()
    for method in ("add_local_dir", "run_commands", "env", "workdir"):
        getattr(image, method).return_value = image
    image_class = Mock()
    image_class.base.return_value = image
    snapshot_params = Mock()
    resources = Mock()
    monkeypatch.setitem(
        sys.modules,
        "daytona",
        SimpleNamespace(
            CreateSnapshotParams=snapshot_params,
            Daytona=Mock(),
            Image=image_class,
            Resources=resources,
        ),
    )
    create_base_snapshot = runpy.run_path(str(ROOT / "packages/daytona-infra/src/toolchain.py"))[
        "create_base_snapshot"
    ]
    daytona = SimpleNamespace(snapshot=SimpleNamespace(create=Mock()))

    create_base_snapshot(daytona, bundle.PackedBundle(tmp_path, PLAN), "snapshot-name", 4)

    resources.assert_called_once_with(memory=4)
    snapshot_params.assert_called_once_with(
        name="snapshot-name",
        image=image,
        resources=resources.return_value,
        entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
    )
    assert daytona.snapshot.create.call_args.args == (snapshot_params.return_value,)
    assert callable(daytona.snapshot.create.call_args.kwargs["on_logs"])


@pytest.mark.parametrize("memory_gib", ["", "0", "-1", "1.5"])
def test_daytona_config_rejects_invalid_snapshot_memory(monkeypatch, memory_gib):
    monkeypatch.setenv("DAYTONA_API_KEY", "test")
    monkeypatch.setenv("DAYTONA_BASE_SNAPSHOT", "snapshot")
    monkeypatch.setenv("DAYTONA_BASE_SNAPSHOT_MEMORY_GIB", memory_gib)
    load_config = runpy.run_path(str(ROOT / "packages/daytona-infra/src/config.py"))["load_config"]

    with pytest.raises(
        RuntimeError, match="DAYTONA_BASE_SNAPSHOT_MEMORY_GIB must be a positive integer"
    ):
        load_config()


def test_daytona_config_loads_snapshot_memory(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "test")
    monkeypatch.setenv("DAYTONA_BASE_SNAPSHOT", "snapshot")
    monkeypatch.setenv("DAYTONA_BASE_SNAPSHOT_MEMORY_GIB", "4")
    load_config = runpy.run_path(str(ROOT / "packages/daytona-infra/src/config.py"))["load_config"]

    assert load_config().base_snapshot_memory_gib == 4


class FakeBoatApi:
    """Records the Boat calls an image build makes, in order."""

    def __init__(
        self, *, retained: bool = False, verify_fails: bool = False, retained_status: str = "ready"
    ) -> None:
        self.retained = retained
        self.retained_status = retained_status
        self.verify_fails = verify_fails
        self.calls: list[tuple] = []
        self.created: list[tuple[str, dict]] = []

    def get_saved_snapshot(self, name):
        self.calls.append(("get_saved_snapshot", name))
        return {"name": name, "status": self.retained_status} if self.retained else None

    def wait_saved_snapshot(self, name, timeout=0):
        self.calls.append(("wait_saved_snapshot", name))
        return {"name": name, "status": "ready"}

    def create_sandbox(self, purpose, body):
        sandbox_id = f"bx_{len(self.created) + 1:08d}"
        self.created.append((sandbox_id, body))
        self.calls.append(("create_sandbox", sandbox_id, purpose, body))
        return {"id": sandbox_id, "state": "provisioning"}

    def wait_ready(self, sandbox_id, timeout=0):
        self.calls.append(("wait_ready", sandbox_id))
        return {"id": sandbox_id, "state": "ready"}

    def write_file(self, sandbox_id, path, content):
        self.calls.append(("write_file", sandbox_id, path, len(content)))

    def run(self, sandbox_id, command, timeout_seconds):
        self.calls.append(("run", sandbox_id, command))
        return {"exitCode": 0, "stdout": "", "stderr": "", "timedOut": False}

    def run_detached(self, sandbox_id, command, timeout):
        self.calls.append(("run_detached", sandbox_id, command))
        if self.verify_fails and command.endswith("smoke_test.py verify"):
            raise RuntimeError("Command failed (exit 1)")

    def stop_and_wait(self, sandbox_id, timeout=0):
        self.calls.append(("stop_and_wait", sandbox_id))

    def save_saved_snapshot(self, sandbox_id, name, timeout=0):
        self.calls.append(("save_saved_snapshot", sandbox_id, name))
        return {"name": name, "status": "ready"}

    def delete_sandbox(self, sandbox_id):
        self.calls.append(("delete_sandbox", sandbox_id))


def load_boat_builder(monkeypatch, api: FakeBoatApi):
    namespace = runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))
    # run_path hands back a copy of the module globals; the functions keep the original.
    monkeypatch.setitem(
        namespace["main"].__globals__, "BoatApi", lambda api_url, api_key, org=None: api
    )
    monkeypatch.setenv("BOAT_API_KEY", "boat_test")
    monkeypatch.setenv("BOAT_BASE_SNAPSHOT", "prefix")
    return namespace


@pytest.mark.parametrize("failed", [False, True])
@pytest.mark.parametrize("retained", [False, True])
def test_boat_retry_reuses_ready_saved_snapshot(monkeypatch, build_mocks, failed, retained):
    api = FakeBoatApi(retained=retained, verify_fails=failed)
    main = load_boat_builder(monkeypatch, api)["main"]
    if failed:
        with pytest.raises(RuntimeError, match="verification failed"):
            main([])
        build_mocks.assert_not_called()
    else:
        main([])
        build_mocks.assert_called_once_with(EXPECTED_NAME)

    names = [call[0] for call in api.calls]
    builds = [body for _, body in api.created if "from" not in body]
    verifies = [body for _, body in api.created if body.get("from") == EXPECTED_NAME]
    assert len(builds) == (0 if retained else 1)
    assert len(verifies) == 1
    assert names.count("save_saved_snapshot") == (0 if retained else 1)
    # Every sandbox the build started is deleted, on success and on failure.
    assert names.count("delete_sandbox") == len(api.created)
    # A fresh deploy prepares the boot-time links before the image verification.
    verify_id = next(sandbox_id for sandbox_id, body in api.created if "from" in body)
    verify_calls = [call for call in api.calls if len(call) > 1 and call[1] == verify_id]
    assert (
        "run",
        verify_id,
        "bash /home/user/openinspect/launcher.sh --prepare-only",
    ) in verify_calls
    verification = next(call for call in verify_calls if call[0] == "run_detached")
    assert verification[2].endswith("/app/verify/smoke_test.py verify")


def test_boat_refuses_to_rebuild_over_a_failed_saved_snapshot(monkeypatch, build_mocks):
    api = FakeBoatApi(retained=True, retained_status="failed")
    main = load_boat_builder(monkeypatch, api)["main"]

    with pytest.raises(RuntimeError, match="exists with status 'failed'"):
        main([])

    # Nothing was started or published: no build sandbox, no save, no result.
    assert api.created == []
    assert [call[0] for call in api.calls] == ["get_saved_snapshot"]
    build_mocks.assert_not_called()


def test_boat_build_installs_the_bundle_under_the_home_directory(monkeypatch, build_mocks):
    api = FakeBoatApi()
    load_boat_builder(monkeypatch, api)["main"]([])

    build_id, build_body = api.created[0]
    assert build_body["type"] == "default" and "from" not in build_body
    assert [call[2] for call in api.calls if call[0] == "create_sandbox"] == ["build", "verify"]
    uploads = [call for call in api.calls if call[0] == "write_file" and call[1] == build_id]
    assert [call[2] for call in uploads] == [
        "/home/user/openinspect-image.tar.gz",
        "/home/user/openinspect-launcher.sh",
    ]
    assert all(call[3] > 0 for call in uploads)
    commands = [
        call[2] for call in api.calls if call[0] in {"run", "run_detached"} and call[1] == build_id
    ]
    prepare, install, cleanup = commands
    assert "sudo ln -sfn /home/user/openinspect/app /app" in prepare
    assert "sudo ln -sfn /home/user/workspace /workspace" in prepare
    assert "/home/user/openinspect/launcher.sh" in prepare
    assert install.endswith("packages/sandbox-images/install/install.sh")
    assert install.startswith("sudo env APT_CONFIG=")
    assert "rm -rf /home/user/.openinspect" in cleanup
    order = [call[0] for call in api.calls if len(call) > 1 and call[1] == build_id]
    assert (
        order.index("stop_and_wait")
        < order.index("save_saved_snapshot")
        < order.index("delete_sandbox")
    )


def test_boat_candidate_name_must_be_a_valid_saved_snapshot(monkeypatch):
    namespace = runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    with pytest.raises(RuntimeError, match="lowercase"):
        namespace["candidate_name"]("Open_Inspect", "a" * 64)
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "open-inspect-0123456789abcdef")
    assert namespace["candidate_name"]("prefix", "a" * 64) == "open-inspect-0123456789abcdef"


class RecordingTransport:
    """Stands in for BoatApi.request: scripted answers, every call recorded."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, method, path, body=None, *, headers=None, timeout=None):
        self.calls.append((method, path, body, headers or {}))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def boat_api(monkeypatch, answers):
    namespace = runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    api = namespace["BoatApi"]("https://boat.dev/api/v1", "boat_test")
    transport = RecordingTransport(answers)
    api.request = transport
    return namespace, api, transport


def test_boat_builder_saves_and_polls_saved_snapshots(monkeypatch):
    namespace, api, transport = boat_api(monkeypatch, [])
    saving = {"name": EXPECTED_NAME, "status": "saving"}
    ready = {**saving, "status": "ready"}
    transport.answers = [
        namespace["BoatApiError"](404, "not_found", "gone"),
        {"ok": True, "type": "snapshot.saved.saving", "snapshot": saving},
        {"ok": True, "type": "snapshot.saved.info", "snapshot": saving},
        {"ok": True, "type": "snapshot.saved.info", "snapshot": ready},
    ]

    assert api.get_saved_snapshot(EXPECTED_NAME) is None
    assert api.save_saved_snapshot("bx_00000001", EXPECTED_NAME) == ready
    assert transport.calls == [
        ("GET", f"/saved-snapshots/{EXPECTED_NAME}", None, {}),
        (
            "POST",
            "/saved-snapshots",
            {"sandboxId": "bx_00000001", "name": EXPECTED_NAME},
            {},
        ),
        ("GET", f"/saved-snapshots/{EXPECTED_NAME}", None, {}),
        ("GET", f"/saved-snapshots/{EXPECTED_NAME}", None, {}),
    ]


@pytest.mark.parametrize("status,code", [(402, "credit_required"), (409, "save_in_progress")])
def test_boat_builder_preserves_saved_snapshot_errors(monkeypatch, status, code):
    namespace, api, transport = boat_api(monkeypatch, [])
    error = namespace["BoatApiError"](status, code, "refused")
    transport.answers = [error]

    with pytest.raises(namespace["BoatApiError"]) as raised:
        api.save_saved_snapshot("bx_00000001", EXPECTED_NAME)

    assert raised.value is error
    assert transport.calls == [
        (
            "POST",
            "/saved-snapshots",
            {"sandboxId": "bx_00000001", "name": EXPECTED_NAME},
            {},
        )
    ]


@pytest.fixture
def boat_prune(monkeypatch):
    namespace, api, transport = boat_api(monkeypatch, [])
    monkeypatch.setitem(namespace["main"].__globals__, "BoatApi", lambda *args: api)
    monkeypatch.setitem(
        namespace["main"].__globals__,
        "pack_bundle",
        Mock(side_effect=AssertionError("prune must not build an image")),
    )
    monkeypatch.setenv("BOAT_API_KEY", "boat_test")
    monkeypatch.setenv("BOAT_BASE_SNAPSHOT", "prefix")
    monkeypatch.setenv("BOAT_DEPLOYED_SNAPSHOT", "prefix-aaaaaaaaaaaaaaaa")
    monkeypatch.setenv("BOAT_REPLACED_SNAPSHOT", "prefix-bbbbbbbbbbbbbbbb")
    return namespace, transport


def boat_snapshot(digit, day, status="ready"):
    return {
        "name": f"prefix-{digit * 16}",
        "status": status,
        "createdAt": f"2026-01-{day:02d}T00:00:00Z",
    }


@pytest.mark.parametrize("dry_run", [False, True])
def test_boat_prune_only_deletes_exact_terraform_bases(boat_prune, capsys, dry_run):
    namespace, transport = boat_prune
    deployed = boat_snapshot("a", 2)
    previous = boat_snapshot("b", 1)
    old = boat_snapshot("c", 1)
    failed = boat_snapshot("d", 4, "failed")
    saving = boat_snapshot("e", 5, "saving")
    untouched = [
        "oi-img-scope-0123456789abcdef",
        "prefix-0123456789ab-1234567890",
        "other-0123456789abcdef",
        "prefix-staging-0123456789abcdef",
        "prefix-0123456789abcde",
        "prefix-0123456789abcdef0",
        "prefix-0123456789abcdeF",
        "prefix-0123456789abcdef\n",
    ]
    # Artifact order and creation times do not determine deployment history.
    snapshots = [old, failed, deployed, previous, saving] + [
        {**old, "name": name} for name in untouched
    ]
    before = {
        "snapshots": snapshots,
        "allowance": {"used": 12, "included": 10, "extraMonthlyDollars": 3.36},
    }
    after = {
        "snapshots": [deployed, previous, saving],
        "allowance": {"used": 10, "included": 10, "extraMonthlyDollars": 0},
    }
    transport.answers = [before, *([] if dry_run else [{}, {}]), before if dry_run else after]

    namespace["main"](["prune", "--dry-run"] if dry_run else ["prune"])

    expected_deletes = (
        []
        if dry_run
        else [
            ("DELETE", f"/saved-snapshots/{snapshot['name']}", None, {})
            for snapshot in (old, failed)
        ]
    )
    assert transport.calls == [
        ("GET", "/saved-snapshots", None, {}),
        *expected_deletes,
        ("GET", "/saved-snapshots", None, {}),
    ]
    output = capsys.readouterr().out
    assert f"Keep {deployed['name']} (deployed)" in output
    assert f"Keep {previous['name']} (rollback)" in output
    assert f"Keep {saving['name']} (status saving)" in output
    for snapshot in (old, failed):
        assert f"{'Would delete' if dry_run else 'Deleted'} {snapshot['name']}" in output
    assert "allowance before: used/included=12/10, extraMonthlyDollars=3.36" in output
    assert "allowance after" in output
    assert ("used/included=12/10" if dry_run else "used/included=10/10") in output.split("after")[1]
    assert "boat_test" not in output
    assert all(name not in output for name in untouched)


def test_boat_prune_retains_the_explicit_replaced_base_not_newer_artifacts(boat_prune, capsys):
    namespace, transport = boat_prune
    deployed = boat_snapshot("a", 1)
    replaced = boat_snapshot("b", 2)
    other = boat_snapshot("c", 3)
    inventory = {"snapshots": [other, deployed, replaced]}
    transport.answers = [inventory, {}, inventory]

    namespace["main"](["prune"])

    assert [call[1] for call in transport.calls if call[0] == "DELETE"] == [
        f"/saved-snapshots/{other['name']}"
    ]
    output = capsys.readouterr().out
    assert f"Keep {deployed['name']} (deployed)" in output
    assert f"Keep {replaced['name']} (rollback)" in output


@pytest.mark.parametrize("status", [None, "saving", "failed"])
def test_boat_prune_requires_a_ready_deployed_snapshot(boat_prune, status):
    namespace, transport = boat_prune
    snapshots = [boat_snapshot("b", 2), boat_snapshot("c", 1)]
    if status is not None:
        snapshots.append(boat_snapshot("a", 3, status))
    transport.answers = [{"snapshots": snapshots}]

    with pytest.raises(RuntimeError, match="ready Terraform base"):
        namespace["main"](["prune"])

    assert transport.calls == [("GET", "/saved-snapshots", None, {})]


def test_boat_prune_requires_the_deployed_name_to_match_the_prefix(monkeypatch, boat_prune):
    namespace, transport = boat_prune
    deployed = {**boat_snapshot("a", 3), "name": "other-aaaaaaaaaaaaaaaa"}
    monkeypatch.setenv("BOAT_DEPLOYED_SNAPSHOT", deployed["name"])
    transport.answers = [{"snapshots": [deployed, boat_snapshot("b", 2), boat_snapshot("c", 1)]}]

    with pytest.raises(RuntimeError, match="ready Terraform base"):
        namespace["main"](["prune"])

    assert transport.calls == [("GET", "/saved-snapshots", None, {})]


def test_boat_prune_requires_an_explicit_deployed_name(monkeypatch, boat_prune):
    namespace, transport = boat_prune
    monkeypatch.delenv("BOAT_DEPLOYED_SNAPSHOT")

    with pytest.raises(RuntimeError, match="BOAT_DEPLOYED_SNAPSHOT is required"):
        namespace["main"](["prune"])

    assert transport.calls == []


@pytest.mark.parametrize("status", [None, "saving", "failed"])
def test_boat_prune_requires_a_ready_replaced_snapshot(boat_prune, status):
    namespace, transport = boat_prune
    snapshots = [boat_snapshot("a", 3), boat_snapshot("c", 1)]
    if status is not None:
        snapshots.append(boat_snapshot("b", 2, status))
    transport.answers = [{"snapshots": snapshots}]

    with pytest.raises(RuntimeError, match="BOAT_REPLACED_SNAPSHOT must name a ready"):
        namespace["main"](["prune"])

    assert transport.calls == [("GET", "/saved-snapshots", None, {})]


def test_boat_prune_requires_an_explicit_replaced_reference(monkeypatch, boat_prune):
    namespace, transport = boat_prune
    monkeypatch.delenv("BOAT_REPLACED_SNAPSHOT")
    with pytest.raises(RuntimeError, match="BOAT_REPLACED_SNAPSHOT is required"):
        namespace["main"](["prune"])
    assert transport.calls == []


@pytest.mark.parametrize("dry_run", [False, True])
def test_boat_prune_rejects_identical_deployed_and_replaced_names(monkeypatch, boat_prune, dry_run):
    namespace, transport = boat_prune
    monkeypatch.setenv("BOAT_REPLACED_SNAPSHOT", "prefix-aaaaaaaaaaaaaaaa")

    with pytest.raises(RuntimeError, match="BOAT_REPLACED_SNAPSHOT must differ"):
        namespace["main"](["prune", "--dry-run"] if dry_run else ["prune"])

    assert transport.calls == []


def test_boat_prune_deletes_failed_bases_without_a_rollback_candidate(monkeypatch, boat_prune):
    namespace, transport = boat_prune
    monkeypatch.setenv("BOAT_REPLACED_SNAPSHOT", "")
    inventory = {"snapshots": [boat_snapshot("a", 1), boat_snapshot("b", 2, "failed")]}
    transport.answers = [inventory, {}, inventory]

    namespace["main"](["prune"])

    assert transport.calls[1] == ("DELETE", "/saved-snapshots/prefix-bbbbbbbbbbbbbbbb", None, {})


@pytest.mark.parametrize("command", [[], ["prune"], ["prune", "--dry-run"]])
@pytest.mark.parametrize("prefix", ["oi-img", "oi-img-group-sub-group-a-very-long"])
def test_boat_builder_rejects_the_prebuilt_image_namespace(
    monkeypatch, boat_prune, command, prefix
):
    namespace, transport = boat_prune
    monkeypatch.setenv("BOAT_BASE_SNAPSHOT", prefix)
    with pytest.raises(RuntimeError, match="reserved for prebuilt images"):
        namespace["main"](command)
    assert transport.calls == []


@pytest.mark.parametrize("candidate", ["oi-img", "oi-img-scope-0123456789abcdef"])
def test_boat_builder_rejects_a_prebuilt_image_candidate_override(monkeypatch, candidate):
    namespace = runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", candidate)
    with pytest.raises(RuntimeError, match="reserved for prebuilt images"):
        namespace["candidate_name"]("prefix", "a" * 64)


@pytest.mark.parametrize("status", [404, 409, 403, 500])
def test_boat_prune_tolerates_only_delete_404s_and_stops_on_other_errors(
    boat_prune, capsys, status
):
    namespace, transport = boat_prune
    old = boat_snapshot("c", 1)
    older = boat_snapshot("d", 1)
    inventory = {"snapshots": [boat_snapshot("a", 4), boat_snapshot("b", 3), old, older]}
    # Never echo a provider message, which might contain the bearer credential.
    transport.answers = [
        inventory,
        namespace["BoatApiError"](status, "save_in_progress", "boat_test"),
        {},
        inventory,
    ]

    if status == 404:
        namespace["main"](["prune"])
        assert transport.calls[-2:] == [
            ("DELETE", f"/saved-snapshots/{older['name']}", None, {}),
            ("GET", "/saved-snapshots", None, {}),
        ]
        output = capsys.readouterr().out
        assert f"Already absent {old['name']}" in output
        assert f"Deleted {old['name']}" not in output
        assert f"Deleted {older['name']}" in output
    else:
        with pytest.raises(RuntimeError, match=f"prune failed: API {status}") as raised:
            namespace["main"](["prune"])
        assert "boat_test" not in str(raised.value)
        assert len(transport.calls) == 2
    assert transport.calls[:2] == [
        ("GET", "/saved-snapshots", None, {}),
        ("DELETE", f"/saved-snapshots/{old['name']}", None, {}),
    ]


def test_boat_prune_list_failure_deletes_nothing(boat_prune):
    namespace, transport = boat_prune
    transport.answers = [namespace["BoatApiError"](401, "unauthorized", "boat_test")]

    with pytest.raises(RuntimeError, match="prune failed: API 401"):
        namespace["main"](["prune"])

    assert transport.calls == [("GET", "/saved-snapshots", None, {})]


def test_boat_builder_repeats_a_lost_create_under_the_same_key(monkeypatch):
    import urllib.error

    namespace, api, transport = boat_api(monkeypatch, [])
    transport.answers = [
        urllib.error.URLError("timed out"),
        namespace["BoatApiError"](409, "idempotency_in_progress", "minting"),
        {"sandbox": {"id": "bx_00000001", "state": "provisioning", "visibility": None}},
    ]

    sandbox = api.create_sandbox("build", {"type": "small", "ttlSeconds": 60})

    assert sandbox["id"] == "bx_00000001"
    keys = {call[3]["Idempotency-Key"] for call in transport.calls}
    assert len(transport.calls) == 3 and len(keys) == 1
    assert keys.pop() == f"openinspect-image-build-{api.run_id}"
    assert all(call[2]["noEnv"] is True for call in transport.calls)
    # Private from the create on: Boat sets it before the sandbox has a machine.
    assert all(call[2]["visibility"] == "private" for call in transport.calls)


def test_boat_builder_does_not_repeat_a_rejected_create(monkeypatch):
    namespace, api, transport = boat_api(monkeypatch, [])
    transport.answers = [namespace["BoatApiError"](402, "billing_required", "no plan")]

    with pytest.raises(namespace["BoatApiError"], match="billing_required"):
        api.create_sandbox("build", {"type": "small"})
    assert len(transport.calls) == 1


def test_boat_builder_makes_an_organization_sandbox_private(monkeypatch):
    _namespace, api, transport = boat_api(
        monkeypatch,
        [
            {"sandbox": {"id": "bx_00000002", "state": "provisioning", "visibility": "shared"}},
            {"sandbox": {"id": "bx_00000002", "state": "provisioning", "visibility": "private"}},
        ],
    )

    sandbox = api.create_sandbox("verify", {"from": "snap"})

    assert sandbox["visibility"] == "private"
    assert transport.calls[1][:2] == ("POST", "/sandboxes/bx_00000002/unshare")


def test_boat_builder_fails_when_a_sandbox_stays_shared(monkeypatch):
    _namespace, api, transport = boat_api(
        monkeypatch,
        [
            {"sandbox": {"id": "bx_00000003", "state": "provisioning", "visibility": "shared"}},
            {"sandbox": {"id": "bx_00000003", "state": "provisioning", "visibility": "shared"}},
            {"ok": True},
        ],
    )
    with pytest.raises(RuntimeError, match="stayed shared"):
        api.create_sandbox("build", {"type": "small"})

    # The sandbox Boat created would otherwise bill until its TTL.
    assert transport.calls[-1] == (
        "DELETE",
        "/sandboxes/bx_00000003",
        None,
        {"X-Ascii-Confirm-Delete": "bx_00000003"},
    )


def test_boat_builder_deletes_a_sandbox_it_could_not_unshare(monkeypatch):
    namespace, api, transport = boat_api(
        monkeypatch,
        [{"sandbox": {"id": "bx_00000004", "state": "provisioning", "visibility": "shared"}}],
    )
    transport.answers.append(namespace["BoatApiError"](500, "internal_error", "unshare failed"))
    transport.answers.append({"ok": True})
    with pytest.raises(namespace["BoatApiError"]) as raised:
        api.create_sandbox("verify", {"from": "snap"})

    assert raised.value.status == 500
    assert [call[0] for call in transport.calls] == ["POST", "POST", "DELETE"]
    assert transport.calls[-1][1] == "/sandboxes/bx_00000004"


def test_boat_builder_refuses_redirects_and_plain_http():
    namespace = runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))
    handler = namespace["RefuseRedirects"]()
    assert (
        handler.redirect_request(None, None, 302, "Found", {}, "https://elsewhere.example/") is None
    )
    assert namespace["validate_api_url"]("https://boat.dev/api/v1/") == "https://boat.dev/api/v1"
    assert namespace["validate_api_url"]("http://localhost:8788") == "http://localhost:8788"
    with pytest.raises(RuntimeError, match="https"):
        namespace["validate_api_url"]("http://boat.dev/api/v1")
    with pytest.raises(RuntimeError, match="valid URL"):
        namespace["validate_api_url"]("boat.dev")


def test_boat_launcher_matches_the_control_plane_contract():
    """The launcher, the build and the control plane pin the same paths and exit code."""
    launcher = (ROOT / "packages/boat-infra/launcher.sh").read_text()
    provider = (ROOT / "packages/control-plane/src/sandbox/providers/boat-provider.ts").read_text()
    lifecycle = (ROOT / "packages/control-plane/src/sandbox/boat-lifecycle.ts").read_text()
    resources = (
        ROOT / "packages/control-plane/src/image-builds/boat-build-resources.ts"
    ).read_text()
    builder = (ROOT / "packages/boat-infra/build-template.py").read_text()
    assert 'export const BOAT_LAUNCHER_PATH = "/home/user/openinspect/launcher.sh";' in lifecycle
    assert 'LAUNCHER_PATH = f"{INSTALL_HOME}/launcher.sh"' in builder
    assert 'INSTALL_HOME = f"{USER_HOME}/openinspect"' in builder
    assert "const LAUNCHER_ALREADY_RUNNING_EXIT_CODE = 75;" in lifecycle
    assert "EXIT_ALREADY_RUNNING=75" in launcher
    assert (
        'export const BOAT_TUNNEL_ENV_FILE_PATH = "/home/user/workspace/.tunnels.env";' in lifecycle
    )
    # The control plane writes the file there on create and resume alike: Boat
    # holds a write to a starting sandbox until it is ready. The create's setup
    # script waits for the launch marker, then execs the launcher.
    assert "path: BOAT_TUNNEL_ENV_FILE_PATH," in provider
    assert 'export const BOAT_LAUNCH_MARKER_PATH = "/tmp/openinspect-launch";' in lifecycle
    assert "until [ -f ${BOAT_LAUNCH_MARKER_PATH} ]; do sleep 0.2; done" in lifecycle
    assert "`exec ${BOAT_LAUNCHER_PATH}`," in lifecycle
    assert 'ensure_link /workspace "$OI_USER_HOME/workspace"' in launcher
    assert 'ensure_link /app "$OI_INSTALL_HOME/app"' in launcher
    assert "flock -n 9" in launcher
    # The lock guards one machine, so it lives in that machine's /tmp. The first
    # boot takes it while Boat's lazy restore still serves the home directory;
    # once the disk has hydrated, the same path under /home names a different
    # file, and a resumed launcher on the parked machine would start a second
    # runtime beside the first.
    assert "OI_LOCK_FILE=/tmp/openinspect-runtime.lock" in launcher
    assert 'exec 9>"$OI_LOCK_FILE"' in launcher
    assert "export RESTORED_FROM_SNAPSHOT=true" in launcher
    # The runtime, not the launcher, records a completed boot (constants.py).
    constants = (ROOT / "packages/sandbox-runtime/src/sandbox_runtime/constants.py").read_text()
    assert 'BOOT_COMPLETE_MARKER_ENV_VAR = "OI_BOOT_COMPLETE_MARKER"' in constants
    assert "export OI_BOOT_COMPLETE_MARKER" in launcher
    assert 'if [[ -e "$OI_BOOT_COMPLETE_MARKER" ]]' in launcher
    assert ': >"$OI_' not in launcher
    # Cross-boot runtime state lives under the home directory: Boat saves /home, not /tmp.
    assert 'STATE_DIR_ENV_VAR = "OPENINSPECT_STATE_DIR"' in constants
    assert "OI_RUNTIME_STATE_DIR=$OI_STATE_DIR/state" in launcher
    assert 'export OPENINSPECT_STATE_DIR="$OI_RUNTIME_STATE_DIR"' in launcher
    # An image build's lock, log and state stay under /tmp, so the disk saved as
    # the prebuilt image carries none of them (boat-build-resources.ts relies on this).
    assert 'if [[ "${IMAGE_BUILD_MODE:-}" == "true" ]]' in launcher
    assert "OI_STATE_DIR=/tmp/openinspect-image-build" in launcher
    assert "OI_STATE_DIR=$OI_USER_HOME/.openinspect" in launcher
    # A build's env arrives as a file the control plane writes once the sandbox
    # is private; the launcher reads it once and removes it. Both pin the path.
    assert (
        'export const BOAT_IMAGE_BUILD_ENV_FILE_PATH = "/tmp/openinspect-image-build.env";'
        in resources
    )
    assert "OI_BUILD_ENV_FILE=/tmp/openinspect-image-build.env" in launcher
    assert '. "$OI_BUILD_ENV_FILE"' in launcher
    assert 'rm -f "$OI_BUILD_ENV_FILE"' in launcher
    assert "load_build_env\n" in launcher
    # The build callback's provider session id rides the launch as a variable
    # prefix under the shared contract name (sandbox-env.ts), never as an argument.
    assert (
        "`${REPO_IMAGE_CALLBACK_ENV.providerSessionId}=${options.providerSessionId} "
        "${BOAT_LAUNCHER_PATH}`" in lifecycle
    )
    assert 'exec "$OI_PYTHON" -m sandbox_runtime.entrypoint' in launcher
    assert "--prepare-only" in launcher
    assert (
        subprocess.run(["bash", "-n", str(ROOT / "packages/boat-infra/launcher.sh")]).returncode
        == 0
    )
