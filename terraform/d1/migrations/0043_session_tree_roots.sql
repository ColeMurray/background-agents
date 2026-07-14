-- Keep session hierarchies together when paginating the global sidebar.
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;

-- Resolve every hierarchy from its top-level ancestor. Rows in malformed
-- legacy cycles or with missing parents safely become their own roots.
WITH RECURSIVE session_roots(id, root_id, path) AS (
  SELECT s.id, s.id, ',' || s.id || ','
  FROM sessions s
  WHERE s.parent_session_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM sessions parent WHERE parent.id = s.parent_session_id)

  UNION ALL

  SELECT child.id, session_roots.root_id, session_roots.path || child.id || ','
  FROM sessions child
  JOIN session_roots ON child.parent_session_id = session_roots.id
  WHERE instr(session_roots.path, ',' || child.id || ',') = 0
)
UPDATE sessions
SET root_session_id = COALESCE(
  (SELECT root_id FROM session_roots WHERE session_roots.id = sessions.id),
  id
);

CREATE INDEX idx_sessions_root_status_updated
  ON sessions(root_session_id, status, updated_at DESC);
