CREATE TABLE IF NOT EXISTS global_secrets (
  key             TEXT    NOT NULL PRIMARY KEY,
  encrypted_value TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
