CREATE TABLE github_review_state (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  latest_generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Submission lease: held by the latest generation's session for the
  -- duration of its final GitHub writes. Claims are refused while an
  -- unexpired lease is held, serializing claim-vs-submit.
  lease_session_id TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (repo_id, pr_number)
);
CREATE TABLE github_review_sessions (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pr_number, generation)
);
CREATE INDEX idx_github_review_sessions_session ON github_review_sessions(session_id);
