-- MCP server configurations
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('local', 'remote')),
  command    TEXT,
  url        TEXT,
  env        TEXT NOT NULL DEFAULT '{}',
  repo_scope TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((type = 'local' AND command IS NOT NULL) OR (type = 'remote' AND url IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
