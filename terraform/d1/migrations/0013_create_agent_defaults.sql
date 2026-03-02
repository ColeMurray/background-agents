-- Per-user, per-repo default OpenCode agent.
-- userId is the app's user id (e.g. from NextAuth). default_agent is the agent id (e.g. from .opencode/agents/foo.md -> "foo") or NULL for OpenCode default.

CREATE TABLE IF NOT EXISTS agent_defaults (
  user_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_agent TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_owner, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_defaults_user_id ON agent_defaults(user_id);
