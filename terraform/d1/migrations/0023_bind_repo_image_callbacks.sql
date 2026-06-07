ALTER TABLE repo_images ADD COLUMN provider_session_id TEXT;
ALTER TABLE repo_images ADD COLUMN callback_token_hash TEXT;
ALTER TABLE repo_images ADD COLUMN callback_token_expires_at INTEGER;
ALTER TABLE repo_images ADD COLUMN callback_token_used_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_repo_images_callback_build
  ON repo_images(id, provider, status, callback_token_hash, callback_token_used_at);
