ALTER TABLE image_builds ADD COLUMN completion_hash TEXT;
ALTER TABLE image_builds ADD COLUMN finalization_lease_token TEXT;
ALTER TABLE image_builds ADD COLUMN finalization_lease_expires_at INTEGER;
ALTER TABLE image_builds ADD COLUMN provider_session_cleanup_pending INTEGER;
