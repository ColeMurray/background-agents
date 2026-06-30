-- Allow automation and session records to intentionally have no repository.
-- SQLite cannot drop NOT NULL constraints in place, so rebuild the tables.
-- automation_runs references automations(id), so back it up without the foreign
-- key before dropping automations and recreate the final table after the parent
-- table has been renamed.
-- Temp tables are intentionally kept if present: after a partial failure they
-- may be the only copy left, so re-runs use IF NOT EXISTS + INSERT OR REPLACE.

CREATE TABLE IF NOT EXISTS automation_runs_backup (
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
  trigger_run_metadata TEXT
);

INSERT OR REPLACE INTO automation_runs_backup (
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata
)
SELECT
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata
FROM automation_runs;

DROP TABLE automation_runs;

CREATE TABLE IF NOT EXISTS automations_new (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  repo_owner      TEXT,
  repo_name       TEXT,
  base_branch     TEXT,
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
  deleted_at      INTEGER,
  reasoning_effort TEXT,
  event_type      TEXT,
  trigger_config  TEXT,
  trigger_auth_data TEXT,
  user_id         TEXT,
  CHECK ((repo_owner IS NULL) = (repo_name IS NULL)),
  CHECK (repo_owner IS NOT NULL OR base_branch IS NULL),
  CHECK (repo_owner IS NOT NULL OR repo_id IS NULL)
);

INSERT OR REPLACE INTO automations_new (
  id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
  trigger_type, schedule_cron, schedule_tz, model, enabled, next_run_at,
  consecutive_failures, created_by, created_at, updated_at, deleted_at,
  reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id
)
SELECT
  id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
  trigger_type, schedule_cron, schedule_tz, model, enabled, next_run_at,
  consecutive_failures, created_by, created_at, updated_at, deleted_at,
  reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id
FROM automations;

DROP TABLE automations;
ALTER TABLE automations_new RENAME TO automations;

CREATE TABLE automation_runs (
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
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT INTO automation_runs (
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata
)
SELECT
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, trigger_key,
  concurrency_key, trigger_run_metadata
FROM automation_runs_backup;

DROP TABLE automation_runs_backup;

CREATE INDEX IF NOT EXISTS idx_automations_schedule_due
  ON automations (enabled, trigger_type, next_run_at)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule';

CREATE INDEX IF NOT EXISTS idx_automations_repo
  ON automations (repo_owner, repo_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automations_event_match
  ON automations (repo_owner, repo_name, trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type IN ('github_event', 'linear_event');

CREATE INDEX IF NOT EXISTS idx_automations_sentry_match
  ON automations (trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'sentry';

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
  ON automation_runs (automation_id, scheduled_at);

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

CREATE TABLE IF NOT EXISTS sessions_new (
  id          TEXT    PRIMARY KEY,
  title       TEXT,
  repo_owner  TEXT,
  repo_name   TEXT,
  model       TEXT    NOT NULL DEFAULT 'claude-haiku-4-5',
  status      TEXT    NOT NULL DEFAULT 'created',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  reasoning_effort TEXT,
  base_branch TEXT,
  parent_session_id TEXT,
  spawn_source TEXT NOT NULL DEFAULT 'user',
  spawn_depth INTEGER NOT NULL DEFAULT 0,
  automation_id TEXT,
  automation_run_id TEXT,
  scm_login TEXT,
  total_cost REAL NOT NULL DEFAULT 0,
  active_duration_ms INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  pr_count INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  CHECK ((repo_owner IS NULL) = (repo_name IS NULL)),
  CHECK (repo_owner IS NOT NULL OR base_branch IS NULL)
);

INSERT OR REPLACE INTO sessions_new (
  id, title, repo_owner, repo_name, model, status, created_at, updated_at,
  reasoning_effort, base_branch, parent_session_id, spawn_source, spawn_depth,
  automation_id, automation_run_id, scm_login, total_cost, active_duration_ms,
  message_count, pr_count, user_id
)
SELECT
  id, title, repo_owner, repo_name, model, status, created_at, updated_at,
  reasoning_effort, base_branch, parent_session_id, spawn_source, spawn_depth,
  automation_id, automation_run_id, scm_login, total_cost, active_duration_ms,
  message_count, pr_count, user_id
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status_updated
  ON sessions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_repo
  ON sessions (repo_owner, repo_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
  ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_automation
  ON sessions (automation_id)
  WHERE automation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_scm_login
  ON sessions(scm_login, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at
  ON sessions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
  ON sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
  ON sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated_at
  ON sessions(user_id, updated_at DESC);
