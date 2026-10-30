-- Personal access tokens: user-issued credentials that let a local tool call the
-- control plane as that user, within an explicit grant of RBAC permissions.
--
-- Only the SHA-256 hash of a token is stored, so this table cannot yield a
-- working credential. `display_prefix` keeps the leading characters in
-- cleartext so a token is identifiable in a list without revealing anything
-- useful. Every token expires.
--
-- Revocation deletes the row; the `personal_access_token.created` and
-- `personal_access_token.revoked` audit events keep the history. Deleting the
-- owner (including the losing account of a member merge) deletes their tokens.
CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL
);

-- Listing a user's tokens, newest first.
CREATE INDEX idx_personal_access_tokens_user
  ON personal_access_tokens(user_id, created_at DESC);

-- A token's grant, one row per RBAC permission, mirroring role_permissions.
-- The token acts with the intersection of these and its owner's current
-- permissions.
CREATE TABLE personal_access_token_permissions (
  token_id TEXT NOT NULL REFERENCES personal_access_tokens(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (token_id, permission_id)
);
