-- CP-issued opaque credentials (P1 identity propagation): web session tokens
-- and their rotating refresh tokens. Hash-at-rest; the plaintext never touches
-- storage. P2 extends this table with sibling kinds (device-flow, PATs).
--
-- provider/provider_user_id materialize the provider-verified subject captured
-- at exchange so access-token verification resolves a full user principal from
-- the single token_hash point read.
CREATE TABLE api_tokens (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('web_session','web_session_refresh')),
  user_id           TEXT NOT NULL,
  provider          TEXT,              -- verified sign-in provider ('github' | 'google')
  provider_user_id  TEXT,              -- provider-native id verified at exchange
  family_id         TEXT,              -- rotation family (both kinds of a pair share one)
  rotated_to        TEXT,              -- refresh tokens: successor token id once consumed
  created_at        INTEGER NOT NULL,  -- epoch ms
  expires_at        INTEGER NOT NULL,  -- epoch ms
  family_expires_at INTEGER,           -- refresh tokens: family cap, copied through rotation
  revoked_at        INTEGER,
  last_used_at      INTEGER
);

-- Bare-column indexes only (equality predicates); token_hash UNIQUE covers the
-- hot-path point read.
CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX idx_api_tokens_family_id ON api_tokens(family_id);

-- Plain index for the api_tokens retention sweep (ApiTokenStore.deleteExpired),
-- which scans by bare expires_at comparison. Bare column on purpose — fancy
-- predicates skip partial indexes (see migration 0024's lesson).
CREATE INDEX idx_api_tokens_expires_at ON api_tokens(expires_at);
