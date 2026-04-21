CREATE TABLE IF NOT EXISTS repo_agent_cache (
  repo_owner  TEXT NOT NULL,
  repo_name   TEXT NOT NULL,
  branch      TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, branch)
);

CREATE INDEX IF NOT EXISTS idx_repo_agent_cache_updated
  ON repo_agent_cache (updated_at DESC);
