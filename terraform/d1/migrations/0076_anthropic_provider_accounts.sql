-- Anthropic joins the provider-account model (openai, xai, anthropic).
--
-- One migration, by decision: the running worker requires exactly one
-- session_model_provider_auth row per subscription provider, so the window
-- between this apply and the worker deploy is an accepted, documented outage
-- for session create/resume and provider-account pages. Rollback is
-- fix-forward; this migration is never reversed.

-- 1. Widen the authorization table's provider check and record how each
--    authorization is completed: 'device' (provider-polled user code) or
--    'authorization_code' (consent page + pasted code). SQLite cannot alter a
--    CHECK in place, so the table is rebuilt.
CREATE TABLE model_provider_account_authorizations_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'xai', 'anthropic')),
  authorization_kind TEXT NOT NULL DEFAULT 'device'
    CHECK (authorization_kind IN ('device', 'authorization_code')),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'reconnect')),
  provider_account_id TEXT,
  target_account_status TEXT,
  target_account_lifecycle_version INTEGER,
  display_name TEXT,
  encrypted_provider_data TEXT,
  provider_state_version INTEGER CHECK (provider_state_version > 0),
  interval_ms INTEGER NOT NULL DEFAULT 0 CHECK (interval_ms BETWEEN 0 AND 60000),
  next_poll_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('initiating', 'pending', 'processing', 'connected', 'denied', 'expired',
              'failed', 'cancelled', 'superseded')
  ),
  processing_owner TEXT,
  processing_started_at INTEGER,
  result_provider_account_id TEXT,
  reconnected_existing INTEGER CHECK (reconnected_existing IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  FOREIGN KEY (result_provider_account_id) REFERENCES model_provider_accounts(id),
  CHECK (
    (operation = 'create' AND provider_account_id IS NULL
      AND target_account_status IS NULL AND target_account_lifecycle_version IS NULL
      AND display_name IS NOT NULL AND length(display_name) BETWEEN 1 AND 100)
    OR (operation = 'reconnect' AND provider_account_id IS NOT NULL
      AND target_account_status IN ('active', 'disabled', 'reconnect_required')
      AND target_account_lifecycle_version IS NOT NULL
      AND target_account_lifecycle_version >= 0 AND display_name IS NULL)
  ),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'processing' AND processing_owner IS NOT NULL AND processing_started_at IS NOT NULL)
    OR (state <> 'processing' AND processing_owner IS NULL AND processing_started_at IS NULL)
  ),
  CHECK (
    (state IN ('pending', 'processing') AND encrypted_provider_data IS NOT NULL
      AND provider_state_version IS NOT NULL
      AND interval_ms BETWEEN 1000 AND 60000)
    OR (state = 'initiating' AND encrypted_provider_data IS NULL
      AND provider_state_version IS NULL)
    OR (state IN ('connected', 'denied', 'expired', 'failed', 'cancelled', 'superseded')
      AND encrypted_provider_data IS NULL AND provider_state_version IS NULL
      AND completed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'connected' AND result_provider_account_id IS NOT NULL
      AND reconnected_existing IS NOT NULL)
    OR (state <> 'connected' AND result_provider_account_id IS NULL
      AND reconnected_existing IS NULL)
  )
);

INSERT INTO model_provider_account_authorizations_new (
  id, user_id, provider, authorization_kind, operation, provider_account_id,
  target_account_status, target_account_lifecycle_version, display_name,
  encrypted_provider_data, provider_state_version, interval_ms, next_poll_at, expires_at,
  state, processing_owner, processing_started_at, result_provider_account_id,
  reconnected_existing, created_at, updated_at, completed_at
)
SELECT
  id, user_id, provider, 'device', operation, provider_account_id,
  target_account_status, target_account_lifecycle_version, display_name,
  encrypted_provider_data, provider_state_version, interval_ms, next_poll_at, expires_at,
  state, processing_owner, processing_started_at, result_provider_account_id,
  reconnected_existing, created_at, updated_at, completed_at
FROM model_provider_account_authorizations;

DROP TABLE model_provider_account_authorizations;
ALTER TABLE model_provider_account_authorizations_new
  RENAME TO model_provider_account_authorizations;

CREATE INDEX idx_provider_account_authorizations_owner
  ON model_provider_account_authorizations(user_id, state, expires_at);
CREATE INDEX idx_provider_account_authorizations_terminal_cleanup
  ON model_provider_account_authorizations(completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX idx_provider_account_authorizations_reconnect
  ON model_provider_account_authorizations(provider_account_id, state, created_at)
  WHERE operation = 'reconnect';

-- 2. Every existing session gets its Anthropic row. Anthropic never had a
--    legacy scoped-OAuth path, so the backfill is api_key: the platform key or
--    a user secret, exactly what those sessions were already using.
INSERT INTO session_model_provider_auth
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT sessions.id, 'anthropic', 'api_key', NULL, 'legacy_migration', NULL, sessions.created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM session_model_provider_auth existing
  WHERE existing.session_id = sessions.id AND existing.provider = 'anthropic'
);

-- 3. The seed trigger now writes three rows. The control plane upserts over
--    them at create with the resolved selections.
DROP TRIGGER IF EXISTS sessions_seed_legacy_provider_auth;
CREATE TRIGGER sessions_seed_legacy_provider_auth
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'openai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'xai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'anthropic', 'api_key', 'legacy_migration', NEW.created_at);
END;

-- 4. Stored-secret issuance: every time a sandbox receives a stored
--    provider credential the control plane records who got which version, so
--    disable/archive/reconnect can terminate exactly those sandboxes.
CREATE TABLE model_provider_credential_issuances (
  id TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  issued_at INTEGER NOT NULL,
  terminated_at INTEGER,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_credential_issuances_account_live
  ON model_provider_credential_issuances(provider_account_id, credential_version, issued_at)
  WHERE terminated_at IS NULL;
CREATE INDEX idx_provider_credential_issuances_session
  ON model_provider_credential_issuances(session_id, sandbox_id);

-- 5. Durable cleanup outbox: written atomically with the account mutation
--    that revokes future issuance; drained by the fast path and the
--    scheduled worker until every recorded issuance is terminated.
CREATE TABLE model_provider_account_cleanup_outbox (
  id TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('disabled', 'archived', 'reconnected', 'expired')),
  -- Issuances at or below this credential version are the ones to terminate.
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider)
);

CREATE INDEX idx_provider_account_cleanup_outbox_due
  ON model_provider_account_cleanup_outbox(next_attempt_at)
  WHERE processed_at IS NULL;

-- 6. The outbox is written by triggers, so revoking future issuance and
--    recording the cleanup are one statement for every mutation path
--    (disable, archive, reconnect/rotate, expiry fence). Providers whose
--    sandboxes never received a static secret drain with nothing to do.
CREATE TRIGGER model_provider_accounts_enqueue_cleanup
AFTER UPDATE OF status, archived_at ON model_provider_accounts
WHEN (NEW.status IN ('disabled', 'reconnect_required') AND NEW.status <> OLD.status)
  OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
BEGIN
  INSERT INTO model_provider_account_cleanup_outbox
    (id, provider_account_id, provider, reason, credential_version, attempts,
     next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), NEW.id, NEW.provider,
         CASE
           WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'archived'
           WHEN NEW.status = 'disabled' THEN 'disabled'
           ELSE 'expired'
         END,
         COALESCE((SELECT credential_version FROM model_provider_account_credentials
                   WHERE provider_account_id = NEW.id), 1),
         0, NEW.updated_at, NEW.updated_at;
END;

CREATE TRIGGER model_provider_account_credentials_enqueue_cleanup
AFTER UPDATE OF credential_version ON model_provider_account_credentials
WHEN NEW.credential_version > OLD.credential_version
BEGIN
  INSERT INTO model_provider_account_cleanup_outbox
    (id, provider_account_id, provider, reason, credential_version, attempts,
     next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), NEW.provider_account_id, accounts.provider, 'reconnected',
         OLD.credential_version, 0, NEW.updated_at, NEW.updated_at
  FROM model_provider_accounts accounts
  WHERE accounts.id = NEW.provider_account_id;
END;
