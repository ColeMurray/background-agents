-- MCP server configurations
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('stdio', 'remote')),
  command    TEXT,
  url        TEXT,
  env        TEXT NOT NULL DEFAULT '{}',
  repo_scope TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
