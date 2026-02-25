-- Parent-child session tracking for agent-spawned sub-sessions.
-- All columns have safe defaults — existing rows are unaffected.

ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN spawn_source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;

-- Partial index: only index rows that actually have a parent.
-- Top-level sessions (NULL parent) don't bloat the index.
CREATE INDEX idx_sessions_parent_session_id ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
