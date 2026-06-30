-- Repair D1 databases where an earlier 0030 migration was recorded before
-- automation_run_groups.expected_runs was added to the checked-in migration.
-- The migration runner tracks only version IDs, so this must be a forward-only
-- migration instead of editing 0030.

DROP VIEW IF EXISTS automation_run_groups_0032_source;
DROP TABLE IF EXISTS automation_run_groups_0032_new;

CREATE TABLE automation_run_groups_0032_new (
  id                 TEXT    PRIMARY KEY,
  automation_id      TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'starting',
  skip_reason        TEXT,
  failure_reason     TEXT,
  scheduled_at       INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  failure_counted_at INTEGER,
  expected_runs      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE VIEW automation_run_groups_0032_source AS
SELECT
  *,
  0 AS expected_runs
FROM automation_run_groups;

INSERT OR REPLACE INTO automation_run_groups_0032_new (
  id, automation_id, status, skip_reason, failure_reason, scheduled_at,
  started_at, completed_at, created_at, updated_at, failure_counted_at,
  expected_runs
)
SELECT
  id, automation_id, status, skip_reason, failure_reason, scheduled_at,
  started_at, completed_at, created_at, updated_at, failure_counted_at,
  expected_runs
FROM automation_run_groups_0032_source;

DROP VIEW IF EXISTS automation_run_groups_0032_source;
DROP TABLE IF EXISTS automation_run_groups;
ALTER TABLE automation_run_groups_0032_new RENAME TO automation_run_groups;

CREATE INDEX IF NOT EXISTS idx_run_groups_automation_created
  ON automation_run_groups (automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_groups_active_lookup
  ON automation_run_groups (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running')
     OR (status = 'partial_failed' AND completed_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_groups_idempotency
  ON automation_run_groups (automation_id, scheduled_at);
