-- Contract the invocation linkage after migration 0030 backfilled all legacy
-- runs and every supported writer began creating runs as invocation children.
--
-- The copy into automation_runs_new is deliberately unfiltered. If a malformed
-- invocation_id IS NULL row exists, its NOT NULL constraint aborts the migration
-- transaction before the old table is dropped, preserving the row for explicit
-- repair rather than silently deleting or inventing invocation data.

CREATE TABLE automation_runs_new (
  id              TEXT    PRIMARY KEY,
  automation_id   TEXT    NOT NULL,
  session_id      TEXT,
  status          TEXT    NOT NULL DEFAULT 'starting',
  skip_reason     TEXT,
  failure_reason  TEXT,
  scheduled_at    INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  invocation_id   TEXT    NOT NULL,
  repo_owner      TEXT,
  repo_name       TEXT,
  repo_id         INTEGER,
  base_branch     TEXT,
  environment_id  TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT INTO automation_runs_new (
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, invocation_id,
  repo_owner, repo_name, repo_id, base_branch, environment_id
)
SELECT
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, invocation_id,
  repo_owner, repo_name, repo_id, base_branch, environment_id
FROM automation_runs;

DROP TABLE automation_runs;
ALTER TABLE automation_runs_new RENAME TO automation_runs;

CREATE INDEX idx_runs_active_lookup
  ON automation_runs (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running');
CREATE INDEX idx_runs_automation_created
  ON automation_runs (automation_id, created_at DESC);
CREATE INDEX idx_runs_invocation
  ON automation_runs (invocation_id, created_at);
CREATE UNIQUE INDEX idx_runs_invocation_repo
  ON automation_runs (invocation_id, repo_owner, repo_name)
  WHERE repo_owner IS NOT NULL;
CREATE INDEX idx_runs_orphan_sweep
  ON automation_runs (created_at)
  WHERE status = 'starting';
CREATE INDEX idx_runs_session
  ON automation_runs (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_runs_timeout_sweep
  ON automation_runs (started_at)
  WHERE status = 'running';
CREATE UNIQUE INDEX idx_runs_invocation_environment
  ON automation_runs (invocation_id, environment_id)
  WHERE environment_id IS NOT NULL;
