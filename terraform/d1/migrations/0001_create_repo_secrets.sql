CREATE TABLE IF NOT EXISTS repo_secrets (
  repo_id         INTEGER NOT NULL,
  repo_owner      TEXT    NOT NULL,
  repo_name       TEXT    NOT NULL,
  key             TEXT    NOT NULL,
  encrypted_value TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (repo_id, key)
);

CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo_name
  ON repo_secrets (repo_owner, repo_name);
