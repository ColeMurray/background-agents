-- Rename webhook_secret_hash to trigger_auth_data to reflect dual purpose:
-- stores a SHA-256 hash for webhook-type automations and AES-256-GCM
-- encrypted ciphertext for sentry-type automations.
ALTER TABLE automations RENAME COLUMN webhook_secret_hash TO trigger_auth_data;
