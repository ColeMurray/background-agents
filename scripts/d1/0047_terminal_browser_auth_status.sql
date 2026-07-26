WITH
  required_objects(name, type) AS (
    VALUES
      ('verified_email_claims', 'table'),
      ('browser_auth_sessions', 'table'),
      ('oauth_flow_state', 'table'),
      ('oauth_authorization_codes', 'table'),
      ('provider_credentials', 'table'),
      ('idx_user_identities_id_user', 'index'),
      ('idx_user_identities_issuer_subject', 'index'),
      ('idx_verified_email_claims_user', 'index'),
      ('idx_browser_auth_sessions_user', 'index'),
      ('idx_browser_auth_sessions_expires', 'index'),
      ('idx_browser_auth_sessions_absolute_expires', 'index'),
      ('idx_browser_auth_sessions_retention', 'index'),
      ('idx_oauth_flow_state_expires', 'index'),
      ('idx_oauth_authorization_codes_expires', 'index')
  ),
  schema_state AS (
    SELECT
      count(actual.name) AS present,
      count(required.name) AS required,
      EXISTS(
        SELECT 1
        FROM pragma_table_info('user_identities')
        WHERE name = 'provider_issuer' AND upper(type) = 'TEXT'
      ) AS has_provider_issuer
    FROM required_objects AS required
    LEFT JOIN sqlite_master AS actual
      ON actual.name = required.name
     AND actual.type = required.type
  )
SELECT CASE
  WHEN
    (SELECT present FROM schema_state) = 0
    AND NOT (SELECT has_provider_issuer FROM schema_state)
    THEN 'not_applied'
  WHEN
    (SELECT present = required FROM schema_state)
    AND (SELECT has_provider_issuer FROM schema_state)
    AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
    AND (SELECT count(*) FROM pragma_quick_check) = 1
    AND EXISTS(SELECT 1 FROM pragma_quick_check WHERE quick_check = 'ok')
    THEN 'complete'
  ELSE 'partial'
END AS status;
