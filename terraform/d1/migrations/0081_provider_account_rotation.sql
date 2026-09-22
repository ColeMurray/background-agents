-- Additive binding protocol; policy replacement preserves existing fixed defaults.
CREATE TABLE session_creation_claims (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  intent_hash TEXT NOT NULL
);
-- Child inheritance linearizes with binding CAS in the creation transaction.
CREATE TRIGGER session_creation_complete_parent_auth
BEFORE INSERT ON session_creation_claims
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id AND s.parent_session_id IS NOT NULL
  AND (SELECT COUNT(*) FROM session_model_provider_auth b WHERE b.session_id = s.parent_session_id) != 3)
BEGIN
  SELECT RAISE(ABORT, 'parent provider binding unavailable');
END;
DROP TRIGGER model_provider_accounts_protect_default;
CREATE TABLE model_provider_account_defaults_new (
  provider TEXT PRIMARY KEY,
  provider_account_id TEXT,
  unattended_mode TEXT NOT NULL DEFAULT 'provider_account' CHECK (unattended_mode IN ('provider_account', 'api_key')),
  selection_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (selection_mode IN ('fixed', 'random')),
  configured INTEGER NOT NULL DEFAULT 1 CHECK (configured IN (0, 1)),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  mutation_id TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_account_id, provider) REFERENCES model_provider_accounts(id, provider),
  CHECK ((configured = 0 AND provider_account_id IS NULL) OR
    (configured = 1 AND ((selection_mode = 'fixed' AND provider_account_id IS NOT NULL) OR
      (selection_mode = 'random' AND provider_account_id IS NULL))))
);
INSERT INTO model_provider_account_defaults_new
  (provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at)
SELECT provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at
FROM model_provider_account_defaults;
DROP TABLE model_provider_account_defaults;
ALTER TABLE model_provider_account_defaults_new RENAME TO model_provider_account_defaults;

CREATE TABLE model_provider_account_policy_members (
  provider TEXT NOT NULL REFERENCES model_provider_account_defaults(provider) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  PRIMARY KEY (provider, provider_account_id),
  FOREIGN KEY (provider_account_id, provider) REFERENCES model_provider_accounts(id, provider)
);
CREATE TABLE model_provider_account_policy_audit (
  mutation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, policy_revision)
);
CREATE TRIGGER model_provider_accounts_protect_default
BEFORE UPDATE OF status, archived_at ON model_provider_accounts
WHEN (NEW.status = 'disabled' OR NEW.archived_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM model_provider_account_defaults
    WHERE provider_account_id = OLD.id AND provider = OLD.provider
      AND configured = 1 AND selection_mode = 'fixed')
BEGIN
  SELECT RAISE(ABORT, 'provider default account must remain active');
END;

ALTER TABLE session_model_provider_auth ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision > 0);
ALTER TABLE session_model_provider_auth ADD COLUMN allocation_policy_revision INTEGER;
ALTER TABLE session_model_provider_auth ADD COLUMN last_switch_operation_id TEXT;
ALTER TABLE session_model_provider_auth ADD COLUMN updated_by TEXT;
ALTER TABLE session_model_provider_auth ADD COLUMN updated_at INTEGER;
CREATE TABLE session_provider_account_switches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  event_delivered_at INTEGER,
  PRIMARY KEY (session_id, operation_id),
  UNIQUE (session_id, provider, binding_revision)
);

-- Reject a lifecycle race at the same atomic write that persists an allocation.
CREATE TRIGGER session_provider_account_eligible_insert
BEFORE INSERT ON session_model_provider_auth
WHEN NEW.auth_mode = 'provider_account' AND NOT EXISTS (
  SELECT 1 FROM model_provider_accounts WHERE id = NEW.provider_account_id
    AND provider = NEW.provider AND status = 'active' AND archived_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session provider account unavailable');
END;
CREATE TRIGGER session_provider_account_eligible_update
BEFORE UPDATE OF provider_account_id ON session_model_provider_auth
WHEN NEW.auth_mode = 'provider_account' AND NOT EXISTS (
  SELECT 1 FROM model_provider_accounts WHERE id = NEW.provider_account_id
    AND provider = NEW.provider AND status = 'active' AND archived_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session provider account unavailable');
END;
