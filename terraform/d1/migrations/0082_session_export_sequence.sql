ALTER TABLE sessions ADD COLUMN export_sequence INTEGER NOT NULL DEFAULT 0;

-- All existing sessions precede new inserts, regardless of their historical
-- ordering. A stable sequence is enough to fence subsequent export pages.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS sequence
  FROM sessions
)
UPDATE sessions
SET export_sequence = (SELECT sequence FROM numbered WHERE numbered.id = sessions.id);

CREATE TABLE session_export_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);
INSERT INTO session_export_sequence (singleton, last_sequence)
SELECT 1, COUNT(*) FROM sessions;

CREATE UNIQUE INDEX idx_sessions_export_sequence
  ON sessions(export_sequence) WHERE export_sequence > 0;
