CREATE TABLE commit_signing_configuration (
  singleton_id          INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  encrypted_private_key TEXT NOT NULL,
  committer_name        TEXT NOT NULL,
  committer_email       TEXT NOT NULL,
  public_key            TEXT NOT NULL,
  fingerprint           TEXT NOT NULL,
  updated_at            INTEGER NOT NULL
);
