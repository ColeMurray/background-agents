ALTER TABLE model_provider_accounts
  ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0);

CREATE TABLE model_provider_account_authorizations (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'xai')),
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

CREATE INDEX idx_provider_account_authorizations_owner
  ON model_provider_account_authorizations(user_id, state, expires_at);

CREATE INDEX idx_provider_account_authorizations_terminal_cleanup
  ON model_provider_account_authorizations(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE INDEX idx_provider_account_authorizations_reconnect
  ON model_provider_account_authorizations(provider_account_id, state, created_at)
  WHERE operation = 'reconnect';

CREATE TABLE model_provider_account_authorization_attempts (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_account_authorization_attempts_user_time
  ON model_provider_account_authorization_attempts(user_id, attempted_at);
