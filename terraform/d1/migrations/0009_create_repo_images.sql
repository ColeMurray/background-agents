-- Per-repo pre-built image registry
CREATE TABLE IF NOT EXISTS repo_images (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  provider_image_id TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'building',
  build_duration_seconds REAL,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_repo_images_repo_status
  ON repo_images(repo_owner, repo_name, status);
