INSERT INTO model_provider_account_defaults
  (provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at)
SELECT account.provider, account.id, 'provider_account', account.created_by, account.updated_by,
       account.created_at, account.updated_at
FROM model_provider_accounts AS account
WHERE account.status = 'active'
  AND account.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM model_provider_account_defaults AS existing
    WHERE existing.provider = account.provider
  )
  AND 1 = (
    SELECT COUNT(*) FROM model_provider_accounts AS eligible
    WHERE eligible.provider = account.provider
      AND eligible.status = 'active'
      AND eligible.archived_at IS NULL
  );
