ALTER TABLE sessions ADD COLUMN latest_attention_message_id TEXT;
ALTER TABLE sessions ADD COLUMN latest_attention_message_created_at INTEGER;
ALTER TABLE sessions ADD COLUMN latest_attention_at INTEGER;

CREATE TABLE session_read_states (
  user_id                            TEXT NOT NULL,
  session_id                         TEXT NOT NULL,
  acknowledged_attention_message_id TEXT,
  updated_at                         INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_read_states_session
  ON session_read_states(session_id, user_id);
