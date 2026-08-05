-- Environment-level integration settings (design §13.5): the top layer of the
-- integration-settings resolution chain, above the global defaults
-- (integration_settings) and per-repo overrides (integration_repo_settings,
-- 0007). Only the session-scoped integrations (sandbox, code-server) accept
-- this level; the store enforces that allowlist.
--
-- Cascade model matches 0033: an owned child of environments, reclaimed when
-- the environment is deleted. Sessions are unaffected — they resolve settings
-- once at create time.

CREATE TABLE integration_environment_settings (
  integration_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  settings       TEXT NOT NULL,               -- JSON, the integration's override shape
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (integration_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
);
