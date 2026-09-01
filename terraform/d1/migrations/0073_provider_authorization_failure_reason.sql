ALTER TABLE model_provider_account_authorizations
  ADD COLUMN failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason = 'device_authorization_disabled');
