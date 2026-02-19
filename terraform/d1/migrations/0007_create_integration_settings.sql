-- Integration settings: global defaults per integration
CREATE TABLE IF NOT EXISTS integration_settings (
  integration_id TEXT PRIMARY KEY,
  settings       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Integration settings: per-repo overrides
CREATE TABLE IF NOT EXISTS integration_repo_settings (
  integration_id TEXT    NOT NULL,
  repo           TEXT    NOT NULL,
  settings       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (integration_id, repo)
);
