"""Tests for registry models."""

from datetime import datetime

from src.registry.models import Repository, Snapshot, SnapshotStatus


class TestRegistryModels:
    """Test registry model definitions."""

    def test_repository_defaults(self):
        """Test Repository with default values."""
        repo = Repository(owner="acme", name="webapp")

        assert repo.owner == "acme"
        assert repo.name == "webapp"
        assert repo.default_branch == "main"
        assert repo.setup_commands == []
        assert repo.build_commands == []
        assert repo.build_interval_minutes == 30

    def test_repository_custom_commands(self):
        """Test Repository with custom commands."""
        repo = Repository(
            owner="acme",
            name="webapp",
            default_branch="develop",
            setup_commands=["npm install"],
            build_commands=["npm run build"],
        )

        assert repo.default_branch == "develop"
        assert len(repo.setup_commands) == 1
        assert len(repo.build_commands) == 1

    def test_snapshot_creation(self):
        """Test Snapshot model."""
        snapshot = Snapshot(
            id="snap-123",
            repo_owner="acme",
            repo_name="webapp",
            base_sha="abc123",
            status=SnapshotStatus.READY,
            created_at=datetime.utcnow(),
        )

        assert snapshot.id == "snap-123"
        assert snapshot.status == SnapshotStatus.READY
        assert snapshot.expires_at is None
        assert snapshot.error_message is None

    def test_snapshot_status_values(self):
        """Verify snapshot status values."""
        assert SnapshotStatus.BUILDING == "building"
        assert SnapshotStatus.READY == "ready"
        assert SnapshotStatus.FAILED == "failed"
        assert SnapshotStatus.EXPIRED == "expired"
