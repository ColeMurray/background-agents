-- Allow automation and session records to intentionally have no repository.
-- SQLite cannot drop NOT NULL constraints in place, so rebuild the two tables.

CREATE TABLE automations_new (
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
  target_mode     TEXT    NOT NULL DEFAULT 'fixed_single_repo'
);

INSERT INTO automations_new (
  id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
  trigger_type, schedule_cron, schedule_tz, model, enabled, next_run_at,
  consecutive_failures, created_by, created_at, updated_at, deleted_at,
  reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id,
  target_mode
)
SELECT
  id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
  trigger_type, schedule_cron, schedule_tz, model, enabled, next_run_at,
  consecutive_failures, created_by, created_at, updated_at, deleted_at,
  reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id,
  'fixed_single_repo'
FROM automations;

DROP TABLE automations;
ALTER TABLE automations_new RENAME TO automations;

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

CREATE TABLE sessions_new (
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
  user_id TEXT
);

INSERT INTO sessions_new (
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
