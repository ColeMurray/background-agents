-- Personal access tokens: a user-issued credential that lets a local tool read
-- the control plane as that user.
--
-- Only the SHA-256 hash is stored, so this table cannot yield a working
-- credential. `display_prefix` keeps the leading characters in cleartext so a
-- token is identifiable in a list without revealing anything useful.
--
-- Revocation deletes the row: the row's sole purpose is to authenticate, and a
-- revoked-but-present token is a state the lookup would have to remember to
-- exclude.
CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);

-- Listing a user's tokens, newest first.
CREATE INDEX idx_personal_access_tokens_user ON personal_access_tokens(user_id, created_at DESC);
