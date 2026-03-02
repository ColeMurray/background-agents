-- Automation definitions
CREATE TABLE IF NOT EXISTS automations (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  repo_owner      TEXT    NOT NULL,
  repo_name       TEXT    NOT NULL,
  base_branch     TEXT    NOT NULL,
  repo_id         INTEGER,
  instructions    TEXT    NOT NULL,
  trigger_type    TEXT    NOT NULL DEFAULT 'schedule',
  schedule_cron   TEXT,
  schedule_tz     TEXT    NOT NULL DEFAULT 'UTC',
  model           TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  next_run_at     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_automations_schedule_due
  ON automations (enabled, trigger_type, next_run_at)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule';

CREATE INDEX IF NOT EXISTS idx_automations_repo
  ON automations (repo_owner, repo_name)
  WHERE deleted_at IS NULL;

-- Automation run history
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
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
  ON automation_runs (automation_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_runs_automation_status
  ON automation_runs (automation_id, status);

CREATE INDEX IF NOT EXISTS idx_runs_automation_created
  ON automation_runs (automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_session
  ON automation_runs (session_id)
  WHERE session_id IS NOT NULL;

-- Supports recovery sweep queries that filter by status globally (not per automation)
CREATE INDEX IF NOT EXISTS idx_runs_active_status
  ON automation_runs (status, created_at)
  WHERE status IN ('starting', 'running');

-- Extend sessions table with automation linkage
ALTER TABLE sessions ADD COLUMN automation_id TEXT;
ALTER TABLE sessions ADD COLUMN automation_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_automation
  ON sessions (automation_id)
  WHERE automation_id IS NOT NULL;
