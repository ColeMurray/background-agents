-- Session index: migrated from KV to D1 for queryable session listing
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  title       TEXT,
  repo_owner  TEXT    NOT NULL,
  repo_name   TEXT    NOT NULL,
  model       TEXT    NOT NULL DEFAULT 'claude-haiku-4-5',
  status      TEXT    NOT NULL DEFAULT 'created',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status_updated
  ON sessions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_repo
  ON sessions (repo_owner, repo_name, updated_at DESC);

-- Repository metadata: migrated from KV to D1 for batch queries
CREATE TABLE IF NOT EXISTS repo_metadata (
  repo_owner           TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  description          TEXT,
  aliases              TEXT,  -- JSON array
  channel_associations TEXT,  -- JSON array
  keywords             TEXT,  -- JSON array
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name)
);
