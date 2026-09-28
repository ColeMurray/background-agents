from __future__ import annotations

import runpy
from pathlib import Path
from unittest.mock import Mock

import pytest

MODULE = runpy.run_path(str(Path(__file__).parents[1] / "build_template.py"))
CommandStatus = MODULE["CommandStatus"]
SandboxInfo = MODULE["SandboxInfo"]
SnapshotInfo = MODULE["SnapshotInfo"]
build_template = MODULE["build_template"]
candidate_name = MODULE["candidate_name"]
cleanup_snapshots = MODULE["cleanup_snapshots"]
ensure_snapshot_capacity = MODULE["ensure_snapshot_capacity"]
load_client = MODULE["load_client"]
wait_for_command = MODULE["wait_for_command"]


class FakeClient:
    def __init__(self, snapshots=None):
        self.snapshots = list(snapshots or [])
        self.deleted_snapshots = []
        self.deleted_sandboxes = []
        self.created = []
        self.commands = []
        self.stopped = set()

    def create_sandbox(self, **kwargs):
        sandbox = SandboxInfo(id=f"bx_{len(self.created) + 1}", state="ready")
        self.created.append((sandbox, kwargs))
        return sandbox

    def get_sandbox(self, sandbox_id):
        return SandboxInfo(
            id=sandbox_id,
            state="stopped" if sandbox_id in self.stopped else "ready",
            snapshot_available=sandbox_id in self.stopped,
        )

    def write_base64(self, sandbox_id, path, content):
        assert sandbox_id and path == "/tmp/openinspect-image.tar.gz" and content

    def start_command(self, sandbox_id, command):
        self.commands.append((sandbox_id, command))
        return len(self.commands)

    def command_status(self, sandbox_id, process_id):
        return CommandStatus("exited", False, 0, "", "")

    def run_command(self, sandbox_id, command, timeout_seconds):
        self.commands.append((sandbox_id, command))
        return CommandStatus("exited", False, 0, "", "")

    def save_named_snapshot(self, sandbox_id, name):
        self.snapshots.append(SnapshotInfo(name, "ready", "2030-01-01T00:00:00Z"))

    def list_named_snapshots(self):
        return list(self.snapshots)

    def get_named_snapshot(self, name):
        return next(snapshot for snapshot in self.snapshots if snapshot.name == name)

    def delete_named_snapshot(self, name):
        self.deleted_snapshots.append(name)
        self.snapshots = [snapshot for snapshot in self.snapshots if snapshot.name != name]

    def host_port(self, sandbox_id, port):
        return f"https://sandbox-{port}.on.boat.dev?_token=secret"

    def stop_sandbox(self, sandbox_id):
        self.stopped.add(sandbox_id)

    def delete_sandbox(self, sandbox_id):
        self.deleted_sandboxes.append(sandbox_id)

    def close(self):
        pass


@pytest.fixture
def bundle(tmp_path):
    directory = tmp_path / "bundle"
    directory.mkdir()
    (directory / "payload").write_text("payload")
    return MODULE["PackedBundle"](
        directory,
        {
            "provider": "boat",
            "buildHash": "a" * 64,
            "runtimeEnv": {"PACKED_PLAN": "true"},
            "runtimeVersion": "test-runtime",
            "target": {
                "os": "debian",
                "base": "provider-default",
                "node": "24",
                "user": "user",
                "home": "/home/user",
            },
        },
    )


def test_candidate_name_is_deterministic_and_valid(monkeypatch):
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    assert candidate_name("openinspect", "a" * 64) == "openinspect-aaaaaaaaaaaaaaaa"
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "invalid_name")
    with pytest.raises(ValueError, match="named snapshot"):
        candidate_name("openinspect", "a" * 64)


def test_capacity_removes_only_old_managed_snapshots():
    snapshots = [
        SnapshotInfo(f"openinspect-{index}", "ready", f"2030-01-{index + 1:02d}T00:00:00Z")
        for index in range(8)
    ] + [
        SnapshotInfo("unrelated-one", "ready", "2030-01-01T00:00:00Z"),
        SnapshotInfo("unrelated-two", "ready", "2030-01-01T00:00:00Z"),
    ]
    client = FakeClient(snapshots)
    ensure_snapshot_capacity(
        client,
        prefix="openinspect",
        candidate="openinspect-new",
        protected={"openinspect-7"},
    )
    assert client.deleted_snapshots == ["openinspect-0"]
    assert {
        snapshot.name for snapshot in client.snapshots if snapshot.name.startswith("unrelated")
    } == {
        "unrelated-one",
        "unrelated-two",
    }


def test_capacity_fails_when_only_unrelated_or_protected_slots_exist():
    snapshots = [
        SnapshotInfo(f"unrelated-{index}", "ready", "2030-01-01T00:00:00Z") for index in range(10)
    ]
    with pytest.raises(RuntimeError, match="limit reached"):
        ensure_snapshot_capacity(
            FakeClient(snapshots),
            prefix="openinspect",
            candidate="openinspect-new",
            protected=set(),
        )


def test_build_reuses_and_reverifies_existing_candidate(bundle):
    candidate = "openinspect-aaaaaaaaaaaaaaaa"
    client = FakeClient([SnapshotInfo(candidate, "ready", "2030-01-01T00:00:00Z")])
    hosted = Mock()
    assert build_template(client, bundle, "openinspect", verify_host=hosted) == candidate
    assert len(client.created) == 1
    assert client.created[0][1]["snapshot"] == candidate
    assert client.created[0][1]["environment"] is bundle.plan["runtimeEnv"]
    assert client.deleted_sandboxes == ["bx_1"]
    assert not client.deleted_snapshots
    hosted.assert_called_once()


def test_build_creates_installs_verifies_and_cleans(bundle):
    client = FakeClient()

    candidate = build_template(client, bundle, "openinspect", verify_host=Mock())

    assert candidate == "openinspect-aaaaaaaaaaaaaaaa"
    assert len(client.created) == 2
    assert client.created[0][1].get("snapshot") is None
    assert client.created[1][1]["snapshot"] == candidate
    assert any("install/install.sh" in command for _, command in client.commands)
    assert any("smoke_test.py verify" in command for _, command in client.commands)
    assert client.deleted_sandboxes == ["bx_2", "bx_1"]


def test_detached_verifier_failure_has_verification_context():
    client = FakeClient()
    client.command_status = Mock(
        return_value=CommandStatus("exited", False, 1, "", "verification failed")
    )

    with pytest.raises(RuntimeError, match="Boat image verification failed"):
        wait_for_command(
            client,
            "bx_verifier",
            1,
            failure_context="image verification",
        )


def test_failed_new_candidate_is_removed_and_temporary_sandboxes_are_cleaned(bundle):
    client = FakeClient()
    with pytest.raises(RuntimeError, match="websocket failed"):
        build_template(
            client,
            bundle,
            "openinspect",
            verify_host=Mock(side_effect=RuntimeError("websocket failed")),
        )
    assert client.deleted_snapshots == ["openinspect-aaaaaaaaaaaaaaaa"]
    assert client.deleted_sandboxes == ["bx_2", "bx_1"]


def test_accepted_snapshot_save_failure_still_reclaims_the_candidate(bundle):
    class SaveFailureClient(FakeClient):
        def save_named_snapshot(self, sandbox_id, name):
            super().save_named_snapshot(sandbox_id, name)
            raise RuntimeError("save response lost")

    client = SaveFailureClient()
    with pytest.raises(RuntimeError, match="save response lost"):
        build_template(client, bundle, "openinspect", verify_host=Mock())
    assert client.deleted_snapshots == ["openinspect-aaaaaaaaaaaaaaaa"]
    assert client.deleted_sandboxes == ["bx_1"]


def test_cleanup_keeps_current_and_rollback_only():
    client = FakeClient(
        [
            SnapshotInfo("openinspect-old", "ready", "2030-01-01T00:00:00Z"),
            SnapshotInfo("openinspect-current", "ready", "2030-01-02T00:00:00Z"),
            SnapshotInfo("openinspect-rollback", "ready", "2030-01-03T00:00:00Z"),
            SnapshotInfo("customer-template", "ready", "2030-01-01T00:00:00Z"),
        ]
    )
    cleanup_snapshots(
        client,
        prefix="openinspect",
        keep={"openinspect-current", "openinspect-rollback"},
    )
    assert client.deleted_snapshots == ["openinspect-old"]


def test_cleanup_without_an_explicit_previous_snapshot_keeps_the_newest_rollback():
    client = FakeClient(
        [
            SnapshotInfo("openinspect-old", "ready", "2030-01-01T00:00:00Z"),
            SnapshotInfo("openinspect-rollback", "ready", "2030-01-02T00:00:00Z"),
            SnapshotInfo("openinspect-current", "ready", "2030-01-03T00:00:00Z"),
        ]
    )
    cleanup_snapshots(client, prefix="openinspect", keep={"openinspect-current"})
    assert client.deleted_snapshots == ["openinspect-old"]


def test_launcher_guards_preparation_and_marks_resumed_boots():
    launcher = (Path(__file__).parents[1] / "runtime-launcher.sh").read_text()
    assert launcher.index("flock -n 9") < launcher.index("sudo rm -rf /app")
    assert "runtime.pid" in launcher
    assert "runtime-started" in launcher
    assert "export RESTORED_FROM_SNAPSHOT=true" in launcher
    assert "hydration_timeout_seconds=600" in launcher


def test_manual_builder_rejects_plaintext_non_loopback_api_urls(monkeypatch):
    monkeypatch.setenv("BOAT_BUILD_API_KEY", "secret")
    monkeypatch.setenv("BOAT_API_URL", "http://boat.example/api/v1")
    with pytest.raises(ValueError, match="must use HTTPS"):
        load_client()
