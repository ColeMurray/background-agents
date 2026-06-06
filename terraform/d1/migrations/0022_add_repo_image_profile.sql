-- Track which sandbox image profile a repo image was built for.
ALTER TABLE repo_images
  ADD COLUMN image_profile TEXT NOT NULL DEFAULT 'default'
  CHECK (image_profile IN ('default', 'docker'));

CREATE INDEX IF NOT EXISTS idx_repo_images_repo_profile_status
  ON repo_images(repo_owner, repo_name, image_profile, status, created_at DESC);
