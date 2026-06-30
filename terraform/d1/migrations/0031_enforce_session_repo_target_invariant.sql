-- Enforce session repository target consistency in the D1 session index.
-- Repository-backed rows must carry owner/name together. No-repo rows must
-- leave owner/name/base_branch null.

CREATE TABLE IF NOT EXISTS sessions_0031_new (
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

INSERT OR REPLACE INTO sessions_0031_new (
  id, title, repo_owner, repo_name, model, status, created_at, updated_at,
  reasoning_effort, base_branch, parent_session_id, spawn_source, spawn_depth,
  automation_id, automation_run_id, scm_login, total_cost, active_duration_ms,
  message_count, pr_count, user_id
)
SELECT
  id,
  title,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE normalized_repo_owner
  END,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE normalized_repo_name
  END,
  model,
  status,
  created_at,
  updated_at,
  reasoning_effort,
  CASE
    WHEN normalized_repo_owner IS NULL OR normalized_repo_name IS NULL THEN NULL
    ELSE base_branch
  END,
  parent_session_id,
  spawn_source,
  spawn_depth,
  automation_id,
  automation_run_id,
  scm_login,
  total_cost,
  active_duration_ms,
  message_count,
  pr_count,
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
  FROM sessions
);

DROP TABLE IF EXISTS sessions;
ALTER TABLE sessions_0031_new RENAME TO sessions;

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
