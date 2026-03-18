-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so we recreate the table
-- to add a structural integrity check: stdio servers must have a command,
-- remote servers must have a url. The application layer already enforces this
-- via McpServerValidationError, but the DB constraint is defence-in-depth.
--
-- The unique name index from migration 0015 is also recreated here.

CREATE TABLE mcp_servers_new (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('stdio', 'remote')),
  command    TEXT,
  url        TEXT,
  env        TEXT NOT NULL DEFAULT '{}',
  repo_scope TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((type = 'stdio' AND command IS NOT NULL) OR (type = 'remote' AND url IS NOT NULL))
);

INSERT INTO mcp_servers_new SELECT * FROM mcp_servers;

DROP TABLE mcp_servers;

ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
