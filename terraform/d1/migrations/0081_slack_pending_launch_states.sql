CREATE TABLE slack_pending_launch_states (
  locator_key TEXT PRIMARY KEY,
  selected_value TEXT NOT NULL,
  session_id TEXT,
  snapshot_json TEXT,
  attachment_references_json TEXT,
  attachment_drops_json TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_pending_launch_states_expires_at
  ON slack_pending_launch_states (expires_at);
