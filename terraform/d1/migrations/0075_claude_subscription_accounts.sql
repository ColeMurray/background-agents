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
  VALUES (NEW.id, 'anthropic', 'api_key', 'api_key_migration', NEW.created_at);
END;

INSERT INTO session_model_provider_auth
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT sessions.id, 'anthropic', 'api_key', NULL, 'api_key_migration', NULL, sessions.created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1
  FROM session_model_provider_auth
  WHERE session_model_provider_auth.session_id = sessions.id
    AND session_model_provider_auth.provider = 'anthropic'
);
