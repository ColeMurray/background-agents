CREATE TABLE managed_secret_redaction_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encrypted_value TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER archive_deleted_environment_secret_for_redaction
BEFORE DELETE ON environment_secrets
BEGIN
  INSERT OR IGNORE INTO managed_secret_redaction_history (encrypted_value, created_at)
  VALUES (OLD.encrypted_value, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TABLE provider_credential_redaction_history (
  provider_account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_schema_version INTEGER NOT NULL,
  encrypted_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER archive_provider_credential_for_redaction
BEFORE UPDATE OF encrypted_payload ON model_provider_account_credentials
BEGIN
  INSERT INTO provider_credential_redaction_history
    (provider_account_id, provider, credential_schema_version, encrypted_payload, created_at)
  SELECT OLD.provider_account_id, accounts.provider, OLD.credential_schema_version,
         OLD.encrypted_payload, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM model_provider_accounts accounts
  WHERE accounts.id = OLD.provider_account_id;
END;

CREATE TRIGGER archive_deleted_provider_credential_for_redaction
BEFORE DELETE ON model_provider_account_credentials
BEGIN
  INSERT INTO provider_credential_redaction_history
    (provider_account_id, provider, credential_schema_version, encrypted_payload, created_at)
  SELECT OLD.provider_account_id, accounts.provider, OLD.credential_schema_version,
         OLD.encrypted_payload, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM model_provider_accounts accounts
  WHERE accounts.id = OLD.provider_account_id;
END;

CREATE TABLE mcp_credential_redaction_history (
  encrypted_env TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER archive_mcp_credentials_for_redaction
BEFORE UPDATE OF env ON mcp_servers
WHEN OLD.env <> NEW.env AND OLD.env NOT IN ('', '{}', 'null')
BEGIN
  INSERT INTO mcp_credential_redaction_history (encrypted_env, created_at)
  VALUES (OLD.env, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER archive_deleted_mcp_credentials_for_redaction
BEFORE DELETE ON mcp_servers
WHEN OLD.env NOT IN ('', '{}', 'null')
BEGIN
  INSERT INTO mcp_credential_redaction_history (encrypted_env, created_at)
  VALUES (OLD.env, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TABLE scm_credential_redaction_history (
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER archive_scm_credentials_for_redaction
BEFORE UPDATE OF access_token_encrypted, refresh_token_encrypted ON user_scm_tokens
BEGIN
  INSERT INTO scm_credential_redaction_history
    (access_token_encrypted, refresh_token_encrypted, created_at)
  VALUES (OLD.access_token_encrypted, OLD.refresh_token_encrypted,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER archive_deleted_scm_credentials_for_redaction
BEFORE DELETE ON user_scm_tokens
BEGIN
  INSERT INTO scm_credential_redaction_history
    (access_token_encrypted, refresh_token_encrypted, created_at)
  VALUES (OLD.access_token_encrypted, OLD.refresh_token_encrypted,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
