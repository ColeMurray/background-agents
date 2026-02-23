-- Add image_build_enabled flag to repo_metadata for the image build scheduler.
-- Repos with this flag set to 1 will have pre-built images maintained by the cron.
ALTER TABLE repo_metadata ADD COLUMN image_build_enabled INTEGER NOT NULL DEFAULT 0;
