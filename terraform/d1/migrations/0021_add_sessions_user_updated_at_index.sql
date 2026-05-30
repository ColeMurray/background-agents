-- Supports creator-filtered session lists ordered by recency.
CREATE INDEX IF NOT EXISTS idx_sessions_user_updated_at
  ON sessions(user_id, updated_at DESC);
