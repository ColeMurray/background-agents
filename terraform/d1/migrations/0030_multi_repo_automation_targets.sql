-- Add fixed multi-repository automation targets and grouped run tracking.

CREATE TABLE IF NOT EXISTS automation_targets (
  automation_id TEXT    NOT NULL,
  repo_owner    TEXT    NOT NULL,
  repo_name     TEXT    NOT NULL,
  repo_id       INTEGER,
  base_branch   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, repo_owner, repo_name),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT OR IGNORE INTO automation_targets (
  automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
)
SELECT
  id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
FROM automations
WHERE deleted_at IS NULL
  AND repo_owner IS NOT NULL
  AND repo_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_targets_repo
  ON automation_targets (repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS automation_run_groups (
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

CREATE TABLE IF NOT EXISTS automation_run_groups_0030_new (
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

DROP VIEW IF EXISTS automation_run_groups_0030_source;
CREATE VIEW automation_run_groups_0030_source AS
SELECT
  *,
  0 AS expected_runs
FROM automation_run_groups;

INSERT OR REPLACE INTO automation_run_groups_0030_new (
  id, automation_id, status, skip_reason, failure_reason, scheduled_at,
  started_at, completed_at, created_at, updated_at, failure_counted_at,
  expected_runs
)
SELECT
  id, automation_id, status, skip_reason, failure_reason, scheduled_at,
  started_at, completed_at, created_at, updated_at, failure_counted_at,
  expected_runs
FROM automation_run_groups_0030_source;

DROP VIEW IF EXISTS automation_run_groups_0030_source;
DROP TABLE IF EXISTS automation_run_groups;
ALTER TABLE automation_run_groups_0030_new RENAME TO automation_run_groups;

CREATE INDEX IF NOT EXISTS idx_run_groups_automation_created
  ON automation_run_groups (automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_groups_active_lookup
  ON automation_run_groups (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running')
     OR (status = 'partial_failed' AND completed_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_groups_idempotency
  ON automation_run_groups (automation_id, scheduled_at);

-- SQLite/D1 do not support a portable ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- Rebuild automation_runs instead so a rerun can handle all of these states:
-- no 0030 columns yet, some columns added by an older partial apply, or the
-- full 0030 schema present but not marked in _schema_migrations.
CREATE TABLE IF NOT EXISTS automation_runs (
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
  trigger_key     TEXT,
  concurrency_key TEXT,
  trigger_run_metadata TEXT,
  group_id TEXT,
  target_repo_owner TEXT,
  target_repo_name TEXT,
  target_repo_id INTEGER,
  target_base_branch TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE TABLE IF NOT EXISTS automation_runs_0030_new (
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
  trigger_key     TEXT,
  concurrency_key TEXT,
  trigger_run_metadata TEXT,
  group_id TEXT,
  target_repo_owner TEXT,
  target_repo_name TEXT,
  target_repo_id INTEGER,
  target_base_branch TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

DROP VIEW IF EXISTS automation_runs_0030_source;
CREATE VIEW automation_runs_0030_source AS
SELECT
  *,
  NULL AS group_id,
  NULL AS target_repo_owner,
  NULL AS target_repo_name,
  NULL AS target_repo_id,
  NULL AS target_base_branch
FROM automation_runs;

INSERT OR REPLACE INTO automation_runs_0030_new (
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata, group_id, target_repo_owner,
  target_repo_name, target_repo_id, target_base_branch
)
SELECT
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata, group_id, target_repo_owner,
  target_repo_name, target_repo_id, target_base_branch
FROM automation_runs_0030_source;

DROP VIEW IF EXISTS automation_runs_0030_source;
DROP TABLE IF EXISTS automation_runs;
ALTER TABLE automation_runs_0030_new RENAME TO automation_runs;

DROP INDEX IF EXISTS idx_runs_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
  ON automation_runs (automation_id, scheduled_at)
  WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_automation_created
  ON automation_runs (automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_session
  ON automation_runs (session_id)
  WHERE session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_trigger_key
  ON automation_runs (automation_id, trigger_key)
  WHERE trigger_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_concurrency
  ON automation_runs (automation_id, concurrency_key, status)
  WHERE concurrency_key IS NOT NULL AND status IN ('starting', 'running');

CREATE INDEX IF NOT EXISTS idx_runs_orphan_sweep
  ON automation_runs (created_at)
  WHERE status = 'starting';

CREATE INDEX IF NOT EXISTS idx_runs_timeout_sweep
  ON automation_runs (started_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_runs_active_lookup
  ON automation_runs (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running');

CREATE INDEX IF NOT EXISTS idx_runs_thread_continuity
  ON automation_runs (automation_id, concurrency_key, created_at DESC)
  WHERE concurrency_key IS NOT NULL AND session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_group
  ON automation_runs (group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_group_target
  ON automation_runs (group_id, target_repo_owner, target_repo_name)
  WHERE group_id IS NOT NULL
    AND target_repo_owner IS NOT NULL
    AND target_repo_name IS NOT NULL;
