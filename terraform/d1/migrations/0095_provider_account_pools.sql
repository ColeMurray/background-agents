-- Random allocation for new sessions. Existing defaults stay selection_mode
-- 'fixed'. A random pool's provider_account_id is one member of the pool so
-- the existing default-account trigger still applies to that row; the full
-- pool lives in model_provider_account_pool_members. No new triggers:
-- ProviderDefaultStore checks that every pool member is an active account.

ALTER TABLE model_provider_account_defaults
  ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'fixed'
  CHECK (selection_mode IN ('fixed', 'random'));

ALTER TABLE model_provider_account_defaults ADD COLUMN write_token TEXT;

CREATE TABLE model_provider_account_pool_members (
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_account_id),
  FOREIGN KEY (provider) REFERENCES model_provider_account_defaults(provider) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider)
);
