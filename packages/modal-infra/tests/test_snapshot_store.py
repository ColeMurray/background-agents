"""Tests for snapshot storage path validation."""

from datetime import UTC, datetime

import pytest

from src.registry.models import Repository, Snapshot, SnapshotStatus
from src.registry.store import SnapshotStore


def make_snapshot(*, snapshot_id: str = "snap-123") -> Snapshot:
    """Create a minimal snapshot for store tests."""
    return Snapshot(
        id=snapshot_id,
        repo_owner="acme",
        repo_name="repo",
        base_sha="abc123",
        status=SnapshotStatus.READY,
        created_at=datetime.now(UTC),
    )


class TestSnapshotStorePathValidation:
    """Reject path traversal in snapshot storage identifiers."""

    @pytest.mark.parametrize("repo_owner", ["../evil", "acme/repo", "acme\\repo"])
    def test_rejects_invalid_repo_owner(self, tmp_path, repo_owner: str):
        store = SnapshotStore(base_path=str(tmp_path))

        with pytest.raises(ValueError, match="repo_owner"):
            store.get_latest_snapshot(repo_owner, "repo")

    @pytest.mark.parametrize("repo_name", ["../evil", "repo/name", "repo\\name"])
    def test_rejects_invalid_repo_name(self, tmp_path, repo_name: str):
        store = SnapshotStore(base_path=str(tmp_path))

        with pytest.raises(ValueError, match="repo_name"):
            store.get_latest_snapshot("acme", repo_name)

    @pytest.mark.parametrize("snapshot_id", ["../evil", "snap/name", "snap\\name"])
    def test_rejects_invalid_snapshot_id(self, tmp_path, snapshot_id: str):
        store = SnapshotStore(base_path=str(tmp_path))

        with pytest.raises(ValueError, match="snapshot_id"):
            store.get_snapshot(snapshot_id, "acme", "repo")

    def test_rejects_invalid_snapshot_id_when_saving(self, tmp_path):
        store = SnapshotStore(base_path=str(tmp_path))

        with pytest.raises(ValueError, match="snapshot_id"):
            store.save_snapshot(make_snapshot(snapshot_id="../evil"))

    def test_rejects_invalid_repository_identifier_when_saving(self, tmp_path):
        store = SnapshotStore(base_path=str(tmp_path))
        repo = Repository(owner="../evil", name="repo")

        with pytest.raises(ValueError, match="repo_owner"):
            store.save_repository(repo)

    def test_accepts_safe_identifiers(self, tmp_path):
        store = SnapshotStore(base_path=str(tmp_path))
        snapshot = make_snapshot(snapshot_id="snap_1.2-3")

        store.save_snapshot(snapshot)

        saved_snapshot = store.get_snapshot("snap_1.2-3", "acme", "repo")
        assert saved_snapshot is not None
        assert saved_snapshot.id == snapshot.id
