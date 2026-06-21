ALTER TABLE repo_images ADD COLUMN provider TEXT NOT NULL DEFAULT 'modal';

CREATE INDEX IF NOT EXISTS idx_repo_images_repo_provider_status
  ON repo_images(repo_owner, repo_name, provider, status, created_at DESC);
