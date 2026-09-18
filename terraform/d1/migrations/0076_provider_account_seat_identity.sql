-- A provider account's external_account_id is the subscription it bills through. On ChatGPT
-- Business/Enterprise that is the workspace, shared by every seat in it, so it cannot tell two
-- colleagues apart. external_principal_id records the seat itself (OpenAI's chatgpt_user_id).
--
-- Accounts connected before this migration have no recorded seat. They keep a NULL principal
-- until their seat next connects, which adopts the row rather than duplicating it, so the
-- uniqueness key collapses NULL to '' to keep a single unadopted row per subscription.
ALTER TABLE model_provider_accounts ADD COLUMN external_principal_id TEXT;

DROP INDEX idx_model_provider_accounts_external_identity;

CREATE UNIQUE INDEX idx_model_provider_accounts_external_identity
  ON model_provider_accounts(provider, external_account_id, COALESCE(external_principal_id, ''))
  WHERE external_account_id IS NOT NULL AND archived_at IS NULL;
