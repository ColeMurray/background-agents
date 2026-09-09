-- Durable receipt and decision ledger for pull-request feedback Autofix.
-- Execution admission remains authoritative in the owning Session Durable
-- Object; this table records why a provider object was or was not dispatched.

CREATE TABLE IF NOT EXISTS pr_autofix_feedback (
  feedback_key           TEXT PRIMARY KEY,
  provider_object_kind   TEXT NOT NULL CHECK (provider_object_kind IN ('pr_comment', 'review')),
  provider_object_id     TEXT NOT NULL,
  delivery_id            TEXT NOT NULL,
  repository_external_id TEXT NOT NULL,
  repo_owner             TEXT NOT NULL,
  repo_name              TEXT NOT NULL,
  pr_number              INTEGER NOT NULL CHECK (pr_number > 0),
  artifact_id            TEXT,
  session_id             TEXT,
  author_id               TEXT,
  author_login            TEXT,
  author_type             TEXT,
  feedback_url            TEXT,
  decision                TEXT NOT NULL CHECK (decision IN ('received', 'queued', 'skipped', 'failed')),
  reason                  TEXT,
  message_id              TEXT,
  dispatch_attempted_at   INTEGER,
  delivery_count          INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  last_error              TEXT,
  first_received_at       INTEGER NOT NULL,
  last_received_at        INTEGER NOT NULL,
  decided_at              INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_autofix_feedback_activity
  ON pr_autofix_feedback (last_received_at DESC, feedback_key DESC);

CREATE INDEX IF NOT EXISTS idx_pr_autofix_feedback_session
  ON pr_autofix_feedback (session_id, last_received_at DESC)
  WHERE session_id IS NOT NULL;
