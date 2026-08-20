CREATE TABLE model_provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_account_id TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  last_verified_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (id, provider),
  CHECK (status IN ('active', 'disabled', 'reconnect_required')),
  CHECK (length(display_name) BETWEEN 1 AND 100)
);

CREATE INDEX idx_model_provider_accounts_provider_status
  ON model_provider_accounts(provider, status, display_name);

CREATE UNIQUE INDEX idx_model_provider_accounts_external_identity
  ON model_provider_accounts(provider, external_account_id)
  WHERE external_account_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE model_provider_account_credentials (
  provider_account_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  credential_schema_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  exchange_generation INTEGER NOT NULL DEFAULT 0,
  exchange_state TEXT NOT NULL DEFAULT 'idle',
  exchange_owner TEXT,
  exchange_started_at INTEGER,
  access_token_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_account_id) REFERENCES model_provider_accounts(id) ON DELETE CASCADE,
  CHECK (credential_schema_version > 0),
  CHECK (credential_version > 0),
  CHECK (exchange_generation >= 0),
  CHECK (exchange_state IN ('idle', 'in_flight')),
  CHECK (
    (exchange_state = 'in_flight' AND exchange_owner IS NOT NULL AND exchange_started_at IS NOT NULL)
    OR (exchange_state = 'idle' AND exchange_owner IS NULL AND exchange_started_at IS NULL)
  )
);

CREATE TABLE model_provider_account_defaults (
  provider TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  unattended_mode TEXT NOT NULL DEFAULT 'provider_account',
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (unattended_mode IN ('provider_account', 'api_key'))
);

CREATE TRIGGER model_provider_accounts_protect_default
BEFORE UPDATE OF status, archived_at ON model_provider_accounts
WHEN (NEW.status = 'disabled' OR NEW.archived_at IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM model_provider_account_defaults
    WHERE provider_account_id = OLD.id AND provider = OLD.provider
  )
BEGIN
  SELECT RAISE(ABORT, 'provider default account must remain active');
END;

CREATE TABLE session_model_provider_auth (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  provider_account_id TEXT,
  selection_source TEXT NOT NULL,
  inherited_from_session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, provider),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  CHECK (auth_mode IN ('provider_account', 'api_key', 'legacy_scoped_oauth')),
  CHECK (
    (auth_mode = 'provider_account' AND provider_account_id IS NOT NULL)
    OR (auth_mode IN ('api_key', 'legacy_scoped_oauth') AND provider_account_id IS NULL)
  )
);

CREATE INDEX idx_session_model_provider_auth_account
  ON session_model_provider_auth(provider_account_id, created_at)
  WHERE provider_account_id IS NOT NULL;

INSERT INTO session_model_provider_auth
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT sessions.id, providers.provider, 'legacy_scoped_oauth', NULL, 'legacy_migration', NULL,
       sessions.created_at
FROM sessions
CROSS JOIN (SELECT 'openai' AS provider UNION ALL SELECT 'xai') AS providers;

CREATE TRIGGER sessions_seed_legacy_provider_auth
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'openai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'xai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
END;

CREATE TABLE automation_model_provider_auth (
  automation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  provider_account_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, provider),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  CHECK (auth_mode IN ('provider_account', 'api_key')),
  CHECK (
    (auth_mode = 'provider_account' AND provider_account_id IS NOT NULL)
    OR (auth_mode = 'api_key' AND provider_account_id IS NULL)
  )
);
