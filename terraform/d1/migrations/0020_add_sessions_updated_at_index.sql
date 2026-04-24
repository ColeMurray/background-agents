-- Supports default session listing ordered by recency when filtering with status != 'archived'.
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
  ON sessions(updated_at DESC);
