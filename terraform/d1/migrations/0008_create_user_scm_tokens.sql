CREATE TABLE IF NOT EXISTS user_scm_tokens (
  provider_user_id        TEXT    NOT NULL,
  access_token_encrypted  TEXT    NOT NULL,
  refresh_token_encrypted TEXT    NOT NULL,
  token_expires_at        INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (provider_user_id)
);
