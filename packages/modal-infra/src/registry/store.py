"""Snapshot metadata storage using Modal volume."""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from .models import Repository, Snapshot, SnapshotMetadata, SnapshotStatus


class SnapshotStore:
    """
    Persistent storage for snapshot metadata.

    Uses Modal volume to persist metadata across function invocations.
    Structure:
        /data/snapshots/{repo_owner}/{repo_name}/
            latest.json  - Latest snapshot info
            history/     - Historical snapshots
                {snapshot_id}.json
        /data/repos/
            {repo_owner}_{repo_name}.json  - Repository config
    """

    def __init__(self, base_path: str = "/data"):
        self.base_path = Path(base_path)
        self.snapshots_path = self.base_path / "snapshots"
        self.repos_path = self.base_path / "repos"

        # Ensure directories exist
        self.snapshots_path.mkdir(parents=True, exist_ok=True)
        self.repos_path.mkdir(parents=True, exist_ok=True)

    _VALID_PATH_SEGMENT_RE = re.compile(r"^[a-zA-Z0-9._-]+$")

    def _validate_path_segment(self, name: str, value: str) -> str:
        """Ensure filesystem path segments cannot escape the storage root."""
        if not self._VALID_PATH_SEGMENT_RE.fullmatch(value):
            raise ValueError(f"Invalid {name}: {value!r}")
        return value

    def _validate_repo_identifiers(self, repo_owner: str, repo_name: str) -> tuple[str, str]:
        """Validate repository owner and name before path construction."""
        return (
            self._validate_path_segment("repo_owner", repo_owner),
            self._validate_path_segment("repo_name", repo_name),
        )

    def _repo_snapshot_dir(self, repo_owner: str, repo_name: str) -> Path:
        """Get snapshot directory for a repository."""
        repo_owner, repo_name = self._validate_repo_identifiers(repo_owner, repo_name)
        path = self.snapshots_path / repo_owner / repo_name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def save_snapshot(self, snapshot: Snapshot, metadata: SnapshotMetadata | None = None) -> None:
        """Save snapshot metadata."""
        repo_dir = self._repo_snapshot_dir(snapshot.repo_owner, snapshot.repo_name)
        snapshot_id = self._validate_path_segment("snapshot_id", snapshot.id)

        # Save to history
        history_dir = repo_dir / "history"
        history_dir.mkdir(exist_ok=True)

        snapshot_file = history_dir / f"{snapshot_id}.json"
        snapshot_file.write_text(snapshot.model_dump_json(indent=2))

        # Save metadata if provided
        if metadata:
            metadata_file = history_dir / f"{snapshot_id}.metadata.json"
            metadata_file.write_text(metadata.model_dump_json(indent=2))

        # Update latest if this snapshot is ready
        if snapshot.status == SnapshotStatus.READY:
            latest_file = repo_dir / "latest.json"
            latest_file.write_text(snapshot.model_dump_json(indent=2))

    def get_latest_snapshot(self, repo_owner: str, repo_name: str) -> Snapshot | None:
        """Get the latest ready snapshot for a repository."""
        repo_dir = self._repo_snapshot_dir(repo_owner, repo_name)
        latest_file = repo_dir / "latest.json"

        if not latest_file.exists():
            return None

        try:
            data = json.loads(latest_file.read_text())
            return Snapshot.model_validate(data)
        except Exception:
            return None

    def get_snapshot(self, snapshot_id: str, repo_owner: str, repo_name: str) -> Snapshot | None:
        """Get a specific snapshot by ID."""
        repo_dir = self._repo_snapshot_dir(repo_owner, repo_name)
        snapshot_id = self._validate_path_segment("snapshot_id", snapshot_id)
        snapshot_file = repo_dir / "history" / f"{snapshot_id}.json"

        if not snapshot_file.exists():
            return None

        try:
            data = json.loads(snapshot_file.read_text())
            return Snapshot.model_validate(data)
        except Exception:
            return None

    def get_snapshot_metadata(
        self,
        snapshot_id: str,
        repo_owner: str,
        repo_name: str,
    ) -> SnapshotMetadata | None:
        """Get metadata for a specific snapshot."""
        repo_dir = self._repo_snapshot_dir(repo_owner, repo_name)
        snapshot_id = self._validate_path_segment("snapshot_id", snapshot_id)
        metadata_file = repo_dir / "history" / f"{snapshot_id}.metadata.json"

        if not metadata_file.exists():
            return None

        try:
            data = json.loads(metadata_file.read_text())
            return SnapshotMetadata.model_validate(data)
        except Exception:
            return None

    def list_snapshots(
        self,
        repo_owner: str,
        repo_name: str,
        limit: int = 10,
    ) -> list[Snapshot]:
        """List recent snapshots for a repository."""
        repo_dir = self._repo_snapshot_dir(repo_owner, repo_name)
        history_dir = repo_dir / "history"

        if not history_dir.exists():
            return []

        snapshots = []
        for file in sorted(history_dir.glob("*.json"), reverse=True):
            if file.name.endswith(".metadata.json"):
                continue

            try:
                data = json.loads(file.read_text())
                snapshots.append(Snapshot.model_validate(data))
            except Exception:
                continue

            if len(snapshots) >= limit:
                break

        return snapshots

    def cleanup_expired(
        self,
        repo_owner: str,
        repo_name: str,
        max_age_days: int = 7,
    ) -> int:
        """Clean up expired snapshots. Returns count of deleted snapshots."""
        repo_dir = self._repo_snapshot_dir(repo_owner, repo_name)
        history_dir = repo_dir / "history"

        if not history_dir.exists():
            return 0

        cutoff = datetime.utcnow() - timedelta(days=max_age_days)
        deleted = 0

        for file in history_dir.glob("*.json"):
            if file.name.endswith(".metadata.json"):
                continue

            try:
                data = json.loads(file.read_text())
                snapshot = Snapshot.model_validate(data)

                if snapshot.created_at < cutoff:
                    file.unlink()
                    # Also delete metadata file
                    metadata_file = history_dir / f"{snapshot.id}.metadata.json"
                    if metadata_file.exists():
                        metadata_file.unlink()
                    deleted += 1
            except Exception:
                continue

        return deleted

    # Repository configuration management

    def save_repository(self, repo: Repository) -> None:
        """Save repository configuration."""
        repo_owner, repo_name = self._validate_repo_identifiers(repo.owner, repo.name)
        repo_file = self.repos_path / f"{repo_owner}_{repo_name}.json"
        repo_file.write_text(repo.model_dump_json(indent=2))

    def get_repository(self, repo_owner: str, repo_name: str) -> Repository | None:
        """Get repository configuration."""
        repo_owner, repo_name = self._validate_repo_identifiers(repo_owner, repo_name)
        repo_file = self.repos_path / f"{repo_owner}_{repo_name}.json"

        if not repo_file.exists():
            return None

        try:
            data = json.loads(repo_file.read_text())
            return Repository.model_validate(data)
        except Exception:
            return None

    def list_repositories(self) -> list[Repository]:
        """List all registered repositories."""
        repos = []

        for file in self.repos_path.glob("*.json"):
            try:
                data = json.loads(file.read_text())
                repos.append(Repository.model_validate(data))
            except Exception:
                continue

        return repos

    def delete_repository(self, repo_owner: str, repo_name: str) -> bool:
        """Delete a repository configuration. Returns True if deleted."""
        repo_owner, repo_name = self._validate_repo_identifiers(repo_owner, repo_name)
        repo_file = self.repos_path / f"{repo_owner}_{repo_name}.json"

        if repo_file.exists():
            repo_file.unlink()
            return True
        return False
