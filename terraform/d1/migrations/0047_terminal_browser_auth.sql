-- Terminal browser authentication storage.
--
-- This migration is deliberately additive. Published legacy token tables stay
-- intact, but terminal stores never project browser credentials into them.

ALTER TABLE user_identities ADD COLUMN provider_issuer TEXT;

UPDATE user_identities
SET provider_issuer = IIF(
  provider = 'github',
  'https://github.com',
  'https://accounts.google.com'
)
WHERE provider_issuer IS NULL
  AND provider IN ('github', 'google');

CREATE UNIQUE INDEX idx_user_identities_id_user
  ON user_identities(id, user_id);

CREATE UNIQUE INDEX idx_user_identities_issuer_subject
  ON user_identities(provider_issuer, provider_user_id)
  WHERE provider_issuer IS NOT NULL;

CREATE TABLE verified_email_claims (
  email                       TEXT NOT NULL PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  source_kind                 TEXT NOT NULL,
  source_provider_identity_id TEXT,
  created_at                  INTEGER NOT NULL,
  last_verified_at            INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (source_provider_identity_id, user_id)
    REFERENCES user_identities(id, user_id),
  CHECK (length(email) > 0 AND email = lower(trim(email))),
  CHECK (source_kind IN (
    'legacy_canonical',
    'provider_verified',
    'trusted_bot_attribution'
  )),
  CHECK (
    (
      source_kind = 'legacy_canonical'
      AND source_provider_identity_id IS NULL
      AND last_verified_at IS NULL
    )
    OR (
      source_kind = 'provider_verified'
      AND source_provider_identity_id IS NOT NULL
      AND last_verified_at IS NOT NULL
    )
    OR (
      source_kind = 'trusted_bot_attribution'
      AND source_provider_identity_id IS NOT NULL
    )
  )
);

CREATE INDEX idx_verified_email_claims_user
  ON verified_email_claims(user_id);

INSERT INTO verified_email_claims (
  email,
  user_id,
  source_kind,
  source_provider_identity_id,
  created_at,
  last_verified_at
)
SELECT
  lower(trim(email)),
  id,
  'legacy_canonical',
  NULL,
  unixepoch() * 1000,
  NULL
FROM users
WHERE email IS NOT NULL;

CREATE TABLE browser_auth_sessions (
  id                   TEXT NOT NULL PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE,
  user_id              TEXT NOT NULL,
  client_id            TEXT NOT NULL,
  provider_identity_id TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  last_used_at         INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  absolute_expires_at  INTEGER NOT NULL,
  revoked_at           INTEGER,
  revoked_reason       TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (provider_identity_id, user_id)
    REFERENCES user_identities(id, user_id),
  CHECK (length(id) > 0),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (client_id = 'web'),
  CHECK (last_used_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK (expires_at > last_used_at),
  CHECK (absolute_expires_at >= expires_at),
  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revoked_at >= created_at
      AND length(revoked_reason) > 0
    )
  )
);

CREATE INDEX idx_browser_auth_sessions_user
  ON browser_auth_sessions(user_id);

CREATE INDEX idx_browser_auth_sessions_expires
  ON browser_auth_sessions(expires_at);

CREATE INDEX idx_browser_auth_sessions_absolute_expires
  ON browser_auth_sessions(absolute_expires_at);

CREATE INDEX idx_browser_auth_sessions_retention
  ON browser_auth_sessions(revoked_at, absolute_expires_at);

CREATE TABLE oauth_flow_state (
  id                                TEXT NOT NULL PRIMARY KEY,
  state_hash                        TEXT NOT NULL UNIQUE,
  provider                          TEXT NOT NULL,
  client_id                         TEXT NOT NULL,
  redirect_uri                      TEXT NOT NULL,
  client_code_challenge             TEXT NOT NULL,
  provider_pkce_verifier_ciphertext TEXT NOT NULL,
  provider_pkce_key_version         INTEGER NOT NULL,
  oidc_nonce_hash                   TEXT,
  created_at                        INTEGER NOT NULL,
  expires_at                        INTEGER NOT NULL,
  consumed_at                       INTEGER,
  CHECK (length(id) > 0),
  CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (provider IN ('github', 'google')),
  CHECK (client_id = 'web'),
  CHECK (length(redirect_uri) > 0),
  CHECK (length(client_code_challenge) = 43),
  CHECK (length(provider_pkce_verifier_ciphertext) > 0),
  CHECK (provider_pkce_key_version = 1),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (provider = 'github' AND oidc_nonce_hash IS NULL)
    OR (
      provider = 'google'
      AND length(oidc_nonce_hash) = 64
      AND oidc_nonce_hash NOT GLOB '*[^0-9a-f]*'
    )
  )
);

CREATE INDEX idx_oauth_flow_state_expires
  ON oauth_flow_state(expires_at);

CREATE TABLE oauth_authorization_codes (
  id                   TEXT NOT NULL PRIMARY KEY,
  code_hash            TEXT NOT NULL UNIQUE,
  user_id              TEXT NOT NULL,
  provider_identity_id TEXT NOT NULL,
  client_id            TEXT NOT NULL,
  redirect_uri         TEXT NOT NULL,
  code_challenge       TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  consumed_at          INTEGER,
  consumed_by          TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (provider_identity_id, user_id)
    REFERENCES user_identities(id, user_id),
  CHECK (length(id) > 0),
  CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (client_id = 'web'),
  CHECK (length(redirect_uri) > 0),
  CHECK (length(code_challenge) = 43),
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND consumed_at >= created_at
      AND length(consumed_by) > 0
    )
  )
);

CREATE INDEX idx_oauth_authorization_codes_expires
  ON oauth_authorization_codes(expires_at);

CREATE TABLE provider_credentials (
  provider_identity_id     TEXT NOT NULL PRIMARY KEY,
  credential_kind          TEXT NOT NULL,
  access_token_ciphertext  TEXT NOT NULL,
  access_expires_at        INTEGER,
  refresh_token_ciphertext TEXT,
  refresh_expires_at       INTEGER,
  encryption_key_version   INTEGER NOT NULL,
  row_version              INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (provider_identity_id) REFERENCES user_identities(id),
  CHECK (length(provider_identity_id) > 0),
  CHECK (length(access_token_ciphertext) > 0),
  CHECK (credential_kind IN (
    'refreshable',
    'access_only_expiring',
    'access_only_nonexpiring'
  )),
  CHECK (encryption_key_version = 1),
  CHECK (row_version >= 1),
  CHECK (
    (
      credential_kind = 'refreshable'
      AND access_expires_at IS NOT NULL
      AND length(refresh_token_ciphertext) > 0
    )
    OR (
      credential_kind = 'access_only_expiring'
      AND access_expires_at IS NOT NULL
      AND refresh_token_ciphertext IS NULL
      AND refresh_expires_at IS NULL
    )
    OR (
      credential_kind = 'access_only_nonexpiring'
      AND access_expires_at IS NULL
      AND refresh_token_ciphertext IS NULL
      AND refresh_expires_at IS NULL
    )
  )
);
