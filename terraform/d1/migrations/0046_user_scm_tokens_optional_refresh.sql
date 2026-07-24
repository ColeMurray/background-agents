-- Allow SCM credential capture without a refresh token.
--
-- Deployments whose GitHub App has "user-to-server token expiration" disabled
-- (or that authenticate with an OAuth App) receive non-expiring access tokens
-- with no refresh token. The token exchange must still capture those
-- credentials — dropping them silently downgrades every push/PR to the shared
-- App bot identity.
--
-- refresh_token_encrypted NULL  = non-refreshable credential
-- token_expires_at        NULL  = non-expiring credential
-- (matching the participants table, where a NULL scm_token_expires_at already
-- means "never expires")
--
-- SQLite cannot drop NOT NULL in place, so rebuild the table.
CREATE TABLE user_scm_tokens_new (
  provider_user_id        TEXT    NOT NULL,
  access_token_encrypted  TEXT    NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at        INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  user_id                 TEXT,
  PRIMARY KEY (provider_user_id)
);

INSERT INTO user_scm_tokens_new (
  provider_user_id,
  access_token_encrypted,
  refresh_token_encrypted,
  token_expires_at,
  created_at,
  updated_at,
  user_id
)
SELECT
  provider_user_id,
  access_token_encrypted,
  refresh_token_encrypted,
  token_expires_at,
  created_at,
  updated_at,
  user_id
FROM user_scm_tokens;

DROP TABLE user_scm_tokens;

ALTER TABLE user_scm_tokens_new RENAME TO user_scm_tokens;
