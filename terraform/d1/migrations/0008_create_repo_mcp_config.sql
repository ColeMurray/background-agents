-- Repository-scoped MCP server configuration
CREATE TABLE IF NOT EXISTS repo_mcp_config (
  repo_owner   TEXT NOT NULL,
  repo_name    TEXT NOT NULL,
  mcp_servers  TEXT NOT NULL, -- JSON object keyed by server name
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name)
);
