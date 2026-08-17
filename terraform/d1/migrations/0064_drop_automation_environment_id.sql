-- Drop the unused scalar environment target superseded by
-- automation_environments in migration 0037. D1 applies migrations with foreign
-- keys enabled, so stage and recreate every FK child around the parent rebuild.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE _bak_automation_runs AS SELECT * FROM automation_runs;
CREATE TABLE _bak_automation_invocations AS SELECT * FROM automation_invocations;
CREATE TABLE _bak_automation_repositories AS SELECT * FROM automation_repositories;
CREATE TABLE _bak_automation_environments AS SELECT * FROM automation_environments;

DROP TABLE automation_runs;
DROP TABLE automation_invocations;
DROP TABLE automation_repositories;
DROP TABLE automation_environments;

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
  invocation_id   TEXT    NOT NULL,
  repo_owner      TEXT,
  repo_name       TEXT,
  repo_id         INTEGER,
  base_branch     TEXT,
  environment_id  TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT INTO automation_runs (
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, invocation_id,
  repo_owner, repo_name, repo_id, base_branch, environment_id
)
SELECT
  id, automation_id, session_id, status, skip_reason, failure_reason,
  scheduled_at, started_at, completed_at, created_at, invocation_id,
  repo_owner, repo_name, repo_id, base_branch, environment_id
FROM _bak_automation_runs;
DROP TABLE _bak_automation_runs;

CREATE TABLE automation_invocations (
  id                 TEXT    PRIMARY KEY,
  automation_id      TEXT    NOT NULL,
  source             TEXT    NOT NULL,
  scheduled_at       INTEGER,
  trigger_key        TEXT,
  concurrency_key    TEXT,
  trigger_metadata   TEXT,
  skip_reason        TEXT,
  failure_counted_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (source <> 'schedule' OR scheduled_at IS NOT NULL),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT INTO automation_invocations (
  id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
  trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at
)
SELECT
  id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
  trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at
FROM _bak_automation_invocations;
DROP TABLE _bak_automation_invocations;

CREATE TABLE automation_repositories (
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

INSERT INTO automation_repositories (
  automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
)
SELECT
  automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
FROM _bak_automation_repositories;
DROP TABLE _bak_automation_repositories;

CREATE TABLE automation_environments (
  automation_id  TEXT    NOT NULL,
  environment_id TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (automation_id, environment_id),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT INTO automation_environments (
  automation_id, environment_id, created_at, updated_at
)
SELECT automation_id, environment_id, created_at, updated_at
FROM _bak_automation_environments;
DROP TABLE _bak_automation_environments;

CREATE INDEX idx_automations_schedule_due
  ON automations (enabled, trigger_type, next_run_at)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule';
CREATE INDEX idx_automations_sentry_match
  ON automations (trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'sentry';
CREATE INDEX idx_automations_active_created_id
  ON automations(created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

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

CREATE UNIQUE INDEX idx_invocations_idempotency
  ON automation_invocations (automation_id, scheduled_at)
  WHERE source = 'schedule';
CREATE UNIQUE INDEX idx_invocations_trigger_key
  ON automation_invocations (automation_id, trigger_key)
  WHERE trigger_key IS NOT NULL;
CREATE INDEX idx_invocations_concurrency
  ON automation_invocations (automation_id, concurrency_key)
  WHERE concurrency_key IS NOT NULL;
CREATE INDEX idx_invocations_automation_created
  ON automation_invocations (automation_id, created_at DESC);
CREATE INDEX idx_invocations_created
  ON automation_invocations (created_at DESC);

CREATE INDEX idx_automation_repositories_repo
  ON automation_repositories (repo_owner, repo_name);
CREATE INDEX idx_automation_environments_environment
  ON automation_environments (environment_id);
