CREATE INDEX idx_sessions_user_non_automation_updated
  ON sessions(user_id, updated_at DESC)
  WHERE automation_id IS NULL;
