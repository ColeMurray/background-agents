-- Workspace scoping for sessions, repositories, and automations.
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT    PRIMARY KEY,
  key        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO workspaces (id, key, name, status, created_at, updated_at)
VALUES ('default', 'default', 'Default Workspace', 'active', unixepoch() * 1000, unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS workspace_repositories (
  workspace_id   TEXT    NOT NULL,
  provider       TEXT    NOT NULL DEFAULT 'github',
  repo_id        INTEGER,
  repo_owner     TEXT    NOT NULL,
  repo_name      TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'execution',
  active         INTEGER NOT NULL DEFAULT 1,
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider, repo_owner, repo_name),
  UNIQUE (provider, repo_owner, repo_name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_repositories_workspace
  ON workspace_repositories (workspace_id, active, repo_owner, repo_name);

ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';

UPDATE sessions
SET workspace_id = 'default'
WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
  ON sessions (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_repo
  ON sessions (workspace_id, repo_owner, repo_name, updated_at DESC);

ALTER TABLE automations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';

UPDATE automations
SET workspace_id = 'default'
WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_automations_workspace_repo
  ON automations (workspace_id, repo_owner, repo_name)
  WHERE deleted_at IS NULL;
