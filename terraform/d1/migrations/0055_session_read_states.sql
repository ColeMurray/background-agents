ALTER TABLE sessions ADD COLUMN latest_terminal_message_id TEXT;
ALTER TABLE sessions ADD COLUMN latest_terminal_message_created_at INTEGER;
ALTER TABLE sessions ADD COLUMN latest_terminal_message_completed_at INTEGER
  CHECK (
    (
      latest_terminal_message_id IS NULL
      AND latest_terminal_message_created_at IS NULL
      AND latest_terminal_message_completed_at IS NULL
    ) OR (
      latest_terminal_message_id IS NOT NULL
      AND latest_terminal_message_created_at IS NOT NULL
      AND latest_terminal_message_completed_at IS NOT NULL
      AND latest_terminal_message_completed_at >= latest_terminal_message_created_at
    )
  );

CREATE TABLE session_read_states (
  user_id              TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_read_states_session
  ON session_read_states(session_id, user_id);
