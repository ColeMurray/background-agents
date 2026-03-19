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

    @pytest.mark.parametrize("repo_owner", ["../evil", "..", ".", "acme/repo", "acme\\repo"])
    def test_invalid_repo_owner_returns_none_for_reads(self, tmp_path, repo_owner: str):
        store = SnapshotStore(base_path=str(tmp_path))

        assert store.get_latest_snapshot(repo_owner, "repo") is None
        assert store.list_snapshots(repo_owner, "repo") == []
        assert store.get_repository(repo_owner, "repo") is None
        assert store.delete_repository(repo_owner, "repo") is False

    @pytest.mark.parametrize("repo_name", ["../evil", "..", ".", "repo/name", "repo\\name"])
    def test_invalid_repo_name_returns_none_for_reads(self, tmp_path, repo_name: str):
        store = SnapshotStore(base_path=str(tmp_path))

        assert store.get_latest_snapshot("acme", repo_name) is None
        assert store.list_snapshots("acme", repo_name) == []
        assert store.get_repository("acme", repo_name) is None
        assert store.delete_repository("acme", repo_name) is False

    @pytest.mark.parametrize("snapshot_id", ["../evil", "..", ".", "snap/name", "snap\\name"])
    def test_invalid_snapshot_id_returns_none_for_reads(self, tmp_path, snapshot_id: str):
        store = SnapshotStore(base_path=str(tmp_path))

        assert store.get_snapshot(snapshot_id, "acme", "repo") is None
        assert store.get_snapshot_metadata(snapshot_id, "acme", "repo") is None

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

    def test_cleanup_expired_skips_invalid_snapshot_id_in_file_contents(self, tmp_path):
        store = SnapshotStore(base_path=str(tmp_path))
        history_dir = tmp_path / "snapshots" / "acme" / "repo" / "history"
        history_dir.mkdir(parents=True)
        invalid_snapshot = make_snapshot(snapshot_id="..").model_dump_json(indent=2)
        (history_dir / "safe-file.json").write_text(invalid_snapshot)

        assert store.cleanup_expired("acme", "repo", max_age_days=0) == 0
        assert (history_dir / "safe-file.json").exists()
