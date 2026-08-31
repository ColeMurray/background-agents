CREATE TABLE cli_device_authorization_attempts (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  device_secret_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  approved_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  exchange_claim_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  exchanged_at INTEGER,
  CHECK ((approved_user_id IS NULL) = (approved_at IS NULL)),
  CHECK (exchanged_at IS NULL OR (approved_user_id IS NOT NULL AND exchange_claim_id IS NOT NULL))
);

CREATE INDEX idx_cli_device_authorization_expiry
ON cli_device_authorization_attempts(expires_at);

CREATE TABLE cli_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_cli_credentials_user
ON cli_credentials(user_id, expires_at);

CREATE INDEX idx_cli_credentials_expiry
ON cli_credentials(expires_at);

CREATE INDEX idx_cli_credentials_revoked
ON cli_credentials(revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE cli_auth_rate_limits (
  rate_key TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rate_key, window_started_at)
);

CREATE INDEX idx_cli_auth_rate_limits_expiry
ON cli_auth_rate_limits(expires_at);
