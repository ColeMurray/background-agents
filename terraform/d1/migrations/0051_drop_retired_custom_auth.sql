-- Better Auth replaced the retired custom browser-auth and API-token storage.
-- Remove the unused schema after the deployment's data-retention checks.
DROP TABLE verified_email_claims;
DROP TABLE browser_auth_sessions;
DROP TABLE oauth_authorization_codes;
DROP TABLE provider_credentials;
DROP TABLE oauth_flow_state;
DROP TABLE api_tokens;
