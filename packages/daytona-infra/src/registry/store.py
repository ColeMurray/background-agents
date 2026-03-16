"""Snapshot metadata storage using S3/MinIO.

Replaces Modal volume storage with S3-compatible object storage (MinIO).
Metadata is stored as JSON objects in the configured S3 bucket.

Structure:
    {bucket}/snapshots/{repo_owner}/{repo_name}/
        latest.json  - Latest snapshot info
        history/
            {snapshot_id}.json
            {snapshot_id}.metadata.json
    {bucket}/repos/
        {repo_owner}_{repo_name}.json  - Repository config
"""

import json
from datetime import datetime, timedelta

from .models import Repository, Snapshot, SnapshotMetadata, SnapshotStatus


class SnapshotStore:
    """
    Persistent storage for snapshot metadata using S3/MinIO.

    Uses boto3 S3 client to persist metadata across API server invocations.
    """

    def __init__(self, s3_client=None, bucket: str = "open-inspect-data"):
        self.s3 = s3_client
        self.bucket = bucket

    def _key(self, *parts: str) -> str:
        """Build an S3 key from path parts."""
        return "/".join(parts)

    def _get_json(self, key: str) -> dict | None:
        """Get and parse a JSON object from S3. Returns None if not found."""
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
            return json.loads(obj["Body"].read().decode("utf-8"))
        except self.s3.exceptions.NoSuchKey:
            return None
        except Exception:
            return None

    def _put_json(self, key: str, data: str) -> None:
        """Write a JSON string to S3."""
        self.s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data.encode("utf-8"),
            ContentType="application/json",
        )

    def _list_keys(self, prefix: str, suffix: str = ".json") -> list[str]:
        """List S3 keys under a prefix, filtered by suffix."""
        keys = []
        try:
            paginator = self.s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    if obj["Key"].endswith(suffix):
                        keys.append(obj["Key"])
        except Exception:
            pass
        return sorted(keys, reverse=True)

    def _delete_key(self, key: str) -> None:
        """Delete an object from S3."""
        try:
            self.s3.delete_object(Bucket=self.bucket, Key=key)
        except Exception:
            pass

    def save_snapshot(self, snapshot: Snapshot, metadata: SnapshotMetadata | None = None) -> None:
        """Save snapshot metadata."""
        history_prefix = self._key("snapshots", snapshot.repo_owner, snapshot.repo_name, "history")

        # Save to history
        snapshot_key = self._key(history_prefix, f"{snapshot.id}.json")
        self._put_json(snapshot_key, snapshot.model_dump_json(indent=2))

        # Save metadata if provided
        if metadata:
            metadata_key = self._key(history_prefix, f"{snapshot.id}.metadata.json")
            self._put_json(metadata_key, metadata.model_dump_json(indent=2))

        # Update latest if this snapshot is ready
        if snapshot.status == SnapshotStatus.READY:
            latest_key = self._key("snapshots", snapshot.repo_owner, snapshot.repo_name, "latest.json")
            self._put_json(latest_key, snapshot.model_dump_json(indent=2))

    def get_latest_snapshot(self, repo_owner: str, repo_name: str) -> Snapshot | None:
        """Get the latest ready snapshot for a repository."""
        latest_key = self._key("snapshots", repo_owner, repo_name, "latest.json")
        data = self._get_json(latest_key)
        if data is None:
            return None
        try:
            return Snapshot.model_validate(data)
        except Exception:
            return None

    def get_snapshot(self, snapshot_id: str, repo_owner: str, repo_name: str) -> Snapshot | None:
        """Get a specific snapshot by ID."""
        key = self._key("snapshots", repo_owner, repo_name, "history", f"{snapshot_id}.json")
        data = self._get_json(key)
        if data is None:
            return None
        try:
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
        key = self._key("snapshots", repo_owner, repo_name, "history", f"{snapshot_id}.metadata.json")
        data = self._get_json(key)
        if data is None:
            return None
        try:
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
        prefix = self._key("snapshots", repo_owner, repo_name, "history") + "/"
        keys = self._list_keys(prefix, suffix=".json")

        snapshots = []
        for key in keys:
            if key.endswith(".metadata.json"):
                continue
            data = self._get_json(key)
            if data is None:
                continue
            try:
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
        prefix = self._key("snapshots", repo_owner, repo_name, "history") + "/"
        keys = self._list_keys(prefix, suffix=".json")

        cutoff = datetime.utcnow() - timedelta(days=max_age_days)
        deleted = 0

        for key in keys:
            if key.endswith(".metadata.json"):
                continue
            data = self._get_json(key)
            if data is None:
                continue
            try:
                snapshot = Snapshot.model_validate(data)
                if snapshot.created_at < cutoff:
                    self._delete_key(key)
                    # Also delete metadata
                    metadata_key = key.replace(".json", ".metadata.json")
                    self._delete_key(metadata_key)
                    deleted += 1
            except Exception:
                continue

        return deleted

    # Repository configuration management

    def save_repository(self, repo: Repository) -> None:
        """Save repository configuration."""
        key = self._key("repos", f"{repo.owner}_{repo.name}.json")
        self._put_json(key, repo.model_dump_json(indent=2))

    def get_repository(self, repo_owner: str, repo_name: str) -> Repository | None:
        """Get repository configuration."""
        key = self._key("repos", f"{repo_owner}_{repo_name}.json")
        data = self._get_json(key)
        if data is None:
            return None
        try:
            return Repository.model_validate(data)
        except Exception:
            return None

    def list_repositories(self) -> list[Repository]:
        """List all registered repositories."""
        keys = self._list_keys("repos/", suffix=".json")
        repos = []
        for key in keys:
            data = self._get_json(key)
            if data is None:
                continue
            try:
                repos.append(Repository.model_validate(data))
            except Exception:
                continue
        return repos

    def delete_repository(self, repo_owner: str, repo_name: str) -> bool:
        """Delete a repository configuration. Returns True if deleted."""
        key = self._key("repos", f"{repo_owner}_{repo_name}.json")
        data = self._get_json(key)
        if data is not None:
            self._delete_key(key)
            return True
        return False
