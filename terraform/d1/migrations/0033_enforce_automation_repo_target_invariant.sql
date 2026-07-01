-- Repair D1 databases where an earlier 0029 migration was recorded before the
-- automations repository-target CHECK constraints were added. The migration
-- runner tracks only numeric version IDs, so changed 0029 SQL cannot repair an
-- already-applied database.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS automations_0033_backup AS
SELECT
  id,
  name,
  repo_owner,
  repo_name,
  base_branch,
  repo_id,
  instructions,
  trigger_type,
  schedule_cron,
  schedule_tz,
  model,
  enabled,
  next_run_at,
  consecutive_failures,
  created_by,
  created_at,
  updated_at,
  deleted_at,
  reasoning_effort,
  event_type,
  trigger_config,
  trigger_auth_data,
  user_id
FROM automations;

CREATE TABLE IF NOT EXISTS automations_0033_new (
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

INSERT OR REPLACE INTO automations_0033_new (
  id,
  name,
  repo_owner,
  repo_name,
  base_branch,
  repo_id,
  instructions,
  trigger_type,
  schedule_cron,
  schedule_tz,
  model,
  enabled,
  next_run_at,
  consecutive_failures,
  created_by,
  created_at,
  updated_at,
  deleted_at,
  reasoning_effort,
  event_type,
  trigger_config,
  trigger_auth_data,
  user_id
)
SELECT
  id,
  name,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE normalized_repo_owner
  END,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE normalized_repo_name
  END,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE base_branch
  END,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE repo_id
  END,
  instructions,
  trigger_type,
  schedule_cron,
  schedule_tz,
  model,
  enabled,
  next_run_at,
  consecutive_failures,
  created_by,
  created_at,
  updated_at,
  deleted_at,
  reasoning_effort,
  event_type,
  trigger_config,
  trigger_auth_data,
  user_id
FROM (
  SELECT
    *,
    NULLIF(
      TRIM(repo_owner, char(9) || char(10) || char(11) || char(12) || char(13) || char(32)),
      ''
    ) AS normalized_repo_owner,
    NULLIF(
      TRIM(repo_name, char(9) || char(10) || char(11) || char(12) || char(13) || char(32)),
      ''
    ) AS normalized_repo_name
  FROM automations_0033_backup
);

DROP TABLE IF EXISTS automations;
ALTER TABLE automations_0033_new RENAME TO automations;
DROP TABLE IF EXISTS automations_0033_backup;

PRAGMA foreign_keys = ON;

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
