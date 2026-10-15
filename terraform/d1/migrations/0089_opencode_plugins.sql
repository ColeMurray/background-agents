CREATE TABLE opencode_plugins (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL UNIQUE,
  repo_scope TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
