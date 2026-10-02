CREATE INDEX idx_sessions_export_roots
  ON sessions(created_at DESC, id ASC);

CREATE INDEX idx_sessions_export_members
  ON sessions(root_session_id, spawn_depth, created_at, id);
