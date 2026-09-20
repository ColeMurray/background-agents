-- Preserve legacy image family; new builds freeze the full non-secret contract.
ALTER TABLE image_builds ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'default'
  CHECK (execution_profile IN ('default', 'docker-v1'));
ALTER TABLE image_builds ADD COLUMN sandbox_execution TEXT NOT NULL DEFAULT '{"profile":"default"}';
CREATE INDEX idx_image_builds_execution_ready
  ON image_builds(scope_kind, scope_id, provider, execution_profile, status, created_at DESC);
