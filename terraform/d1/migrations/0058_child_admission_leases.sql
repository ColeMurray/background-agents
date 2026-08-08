CREATE TABLE child_admission_leases (
  lease_token TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_child_admission_leases_parent
  ON child_admission_leases(parent_session_id, expires_at);
