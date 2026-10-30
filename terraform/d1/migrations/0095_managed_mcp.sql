-- Expand-only: legacy remotes retain explicit static-header semantics and direct routing.
ALTER TABLE mcp_servers ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'service_credentials'
  CHECK (auth_mode IN ('none', 'service_credentials', 'user_oauth'));
ALTER TABLE mcp_servers ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mcp_servers ADD COLUMN managed_routing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_servers ADD COLUMN oauth_profile TEXT;

CREATE TABLE mcp_oauth_clients (
  server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  auth_revision INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  resource TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL
);

CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  auth_revision INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  resource TEXT NOT NULL,
  client_id TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected', 'disconnected', 'reconnect_required')),
  grant_revision INTEGER NOT NULL DEFAULT 1,
  credential_version INTEGER NOT NULL DEFAULT 0,
  encrypted_payload TEXT,
  expires_at INTEGER,
  exchange_owner TEXT,
  exchange_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, server_id)
);

CREATE TABLE mcp_oauth_transactions (
  state_digest TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  grant_revision INTEGER NOT NULL,
  auth_revision INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  encrypted_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'claimed', 'settled', 'invalidated')),
  claim_owner TEXT
);
CREATE INDEX idx_mcp_oauth_transactions_owner ON mcp_oauth_transactions(owner_id);
CREATE INDEX idx_mcp_oauth_transactions_connection ON mcp_oauth_transactions(connection_id);

-- Concrete canonical ownership writers must not transfer grants or erase uncertain exchanges.
-- These predicates run in the writer's transaction, including operator merge batches.
-- A grant is live while it holds credentials or an exchange claim. A credential-free
-- reconnect reservation and its consent transaction stay live only for the OAuth
-- transaction window (MCP_OAUTH_TRANSACTION_TTL_MS), so abandoned consent cannot
-- block identity, user, or server writes forever.
CREATE TRIGGER mcp_block_identity_transfer BEFORE UPDATE OF user_id ON user_identities
WHEN OLD.user_id != NEW.user_id AND (
  EXISTS (SELECT 1 FROM mcp_connections WHERE owner_id IN (OLD.user_id, NEW.user_id)
    AND (status = 'connected' OR encrypted_payload IS NOT NULL OR exchange_owner IS NOT NULL
      OR (status = 'reconnect_required' AND updated_at > unixepoch() * 1000 - 600000))) OR
  EXISTS (SELECT 1 FROM mcp_oauth_transactions WHERE owner_id IN (OLD.user_id, NEW.user_id)
    AND status IN ('pending', 'claimed') AND expires_at > unixepoch() * 1000)
)
BEGIN
  SELECT RAISE(ABORT, 'Disconnect personal MCP connections before moving canonical identity');
END;

CREATE TRIGGER mcp_block_owner_delete BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM mcp_connections WHERE owner_id = OLD.id
    AND (status = 'connected' OR encrypted_payload IS NOT NULL OR exchange_owner IS NOT NULL
      OR (status = 'reconnect_required' AND updated_at > unixepoch() * 1000 - 600000))) OR
  EXISTS (SELECT 1 FROM mcp_oauth_transactions WHERE owner_id = OLD.id AND status IN ('pending', 'claimed')
    AND expires_at > unixepoch() * 1000)
BEGIN
  SELECT RAISE(ABORT, 'Disconnect personal MCP connections before merging canonical users');
END;

CREATE TRIGGER mcp_block_grant_transfer BEFORE UPDATE OF owner_id ON mcp_connections
WHEN OLD.owner_id != NEW.owner_id
BEGIN
  SELECT RAISE(ABORT, 'Personal MCP grants cannot change owner');
END;

-- Deleting an administrator definition cannot cascade away uncertain grant state.
-- Disable it immediately; delete only after its owners disconnect.
CREATE TRIGGER mcp_block_server_delete BEFORE DELETE ON mcp_servers
WHEN EXISTS (SELECT 1 FROM mcp_connections WHERE server_id = OLD.id
  AND (status = 'connected' OR encrypted_payload IS NOT NULL OR exchange_owner IS NOT NULL
    OR (status = 'reconnect_required' AND updated_at > unixepoch() * 1000 - 600000))) OR
  EXISTS (SELECT 1 FROM mcp_oauth_transactions t JOIN mcp_connections c ON c.id = t.connection_id
    WHERE c.server_id = OLD.id AND t.status IN ('pending', 'claimed') AND t.expires_at > unixepoch() * 1000)
BEGIN
  SELECT RAISE(ABORT, 'MCP connections must be disconnected before deleting this server');
END;
