-- The GitHub bot's current review session for one pull request.
-- superseded_by is null on the review that should still run. A newer review
-- sets it, then cancels that session. Mentions are not rows in this table.
CREATE TABLE github_pr_review_sessions (
  session_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  superseded_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_github_pr_review_sessions_current
  ON github_pr_review_sessions (repository_id, pull_number)
  WHERE superseded_by IS NULL;
