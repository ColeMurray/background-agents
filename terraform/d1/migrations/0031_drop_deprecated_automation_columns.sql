-- Migration 0031: drop the deprecated single-repository mirror and the frozen
-- automation_runs firing-key columns.
--
-- The contract-cleanup step deferred by 0030. It is safe because 0030 already
-- backfilled everything these columns held:
--   * automations.repo_*  -> automation_repositories rows, and
--   * each legacy run's trigger_key / concurrency_key / trigger_run_metadata
--     -> its automation_invocations row.
-- Firing keys now live exclusively on automation_invocations; the overlap,
-- dedup, and Slack thread-continuity queries reach them through
-- idx_invocations_concurrency / idx_invocations_trigger_key joined to
-- automation_runs via idx_runs_invocation. Event matching joins
-- automation_repositories (idx_automation_repositories_repo).
--
-- automation_runs has no CHECK constraints, so its frozen columns drop in place
-- once their indexes are gone. automations DOES carry repo_* CHECK constraints
-- (migration 0029), and SQLite cannot DROP COLUMN a CHECK-referenced column, so
-- that table is rebuilt without the mirror columns/CHECKs. defer_foreign_keys
-- lets the rebuild proceed while automation_repositories / automation_invocations
-- / automation_runs still reference automations(id): every automation id is
-- preserved through the copy, so the deferred foreign-key check passes at commit.
-- Comments stay on their own lines so the migration splitter treats each
-- statement cleanly.

PRAGMA defer_foreign_keys = TRUE;

-- ── automation_runs: drop the frozen firing keys (indexes first) ────────────
DROP INDEX IF EXISTS idx_runs_trigger_key;
DROP INDEX IF EXISTS idx_runs_concurrency;
DROP INDEX IF EXISTS idx_runs_thread_continuity;

ALTER TABLE automation_runs DROP COLUMN trigger_key;
ALTER TABLE automation_runs DROP COLUMN concurrency_key;
ALTER TABLE automation_runs DROP COLUMN trigger_run_metadata;

-- ── automations: rebuild without the repo_* mirror columns + CHECKs ─────────
-- (dropping the table drops idx_automations_repo / idx_automations_event_match,
--  both of which indexed the removed repo_* columns).
DROP TABLE IF EXISTS automations_new;

CREATE TABLE automations_new (
  id                   TEXT    PRIMARY KEY,
  name                 TEXT    NOT NULL,
  instructions         TEXT    NOT NULL,
  trigger_type         TEXT    NOT NULL DEFAULT 'schedule',
  schedule_cron        TEXT,
  schedule_tz          TEXT    NOT NULL DEFAULT 'UTC',
  model                TEXT    NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  next_run_at          INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  reasoning_effort     TEXT,
  event_type           TEXT,
  trigger_config       TEXT,
  trigger_auth_data    TEXT,
  user_id              TEXT
);

INSERT INTO automations_new (
  id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
  enabled, next_run_at, consecutive_failures, created_by, created_at, updated_at,
  deleted_at, reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id
)
SELECT
  id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
  enabled, next_run_at, consecutive_failures, created_by, created_at, updated_at,
  deleted_at, reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id
FROM automations;

DROP TABLE automations;
ALTER TABLE automations_new RENAME TO automations;

-- Recreate the surviving automations indexes (the repo_* ones are gone).
CREATE INDEX IF NOT EXISTS idx_automations_schedule_due
  ON automations (enabled, trigger_type, next_run_at)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule';

CREATE INDEX IF NOT EXISTS idx_automations_sentry_match
  ON automations (trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'sentry';
