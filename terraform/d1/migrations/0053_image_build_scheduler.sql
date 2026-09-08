CREATE INDEX idx_repo_metadata_image_build_scope
  ON repo_metadata(image_build_enabled, lower(repo_owner), lower(repo_name));

CREATE INDEX idx_image_builds_session_cleanup
  ON image_builds(created_at, id)
  WHERE status IN ('ready', 'failed', 'superseded')
    AND provider_session_id IS NOT NULL
    AND provider_session_cleanup_pending IS NOT 0;

CREATE INDEX idx_image_builds_superseded_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'superseded'
    AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0);

CREATE INDEX idx_image_builds_failed_artifact_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'failed'
    AND provider_image_id IS NOT NULL
    AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0);

CREATE INDEX idx_image_builds_failed_history_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'failed'
    AND provider_image_id IS NULL
    AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0);

CREATE INDEX idx_image_builds_stale_recovery
  ON image_builds(created_at, id)
  WHERE status = 'building' AND provider_image_id IS NULL;

CREATE INDEX idx_image_builds_finalization_recovery
  ON image_builds(callback_token_used_at, id)
  WHERE status = 'building'
    AND callback_token_used_at IS NOT NULL
    AND completion_hash IS NOT NULL;
