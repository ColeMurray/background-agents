-- feature: mcp
-- The personal MCP lane: one person's own OAuth credential against a
-- reviewed, remote-only server. The core does not have this lane; the
-- feature flag is off by default.
CREATE TABLE mcp_connections (
  id                      TEXT PRIMARY KEY CHECK (id GLOB 'mcpconn_*'),
  owner_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id               TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE RESTRICT,
  server_revision         INTEGER NOT NULL CHECK (server_revision > 0),
  server_name             TEXT NOT NULL,
  endpoint_url            TEXT NOT NULL,
  endpoint_host           TEXT NOT NULL,
  catalog_snapshot_sha256 TEXT NOT NULL CHECK (length(catalog_snapshot_sha256) = 64),
  status                  TEXT NOT NULL DEFAULT 'foundation_staged'
                          CHECK (status IN ('foundation_staged', 'revoking', 'transport_ready',
                                            'oauth_authorizing', 'oauth_ready', 'failed', 'revoked')),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (owner_user_id, server_id)
);

CREATE INDEX idx_mcp_connections_owner
  ON mcp_connections(owner_user_id, updated_at DESC, id);

-- Review metadata may classify a mutation, but this foundation never copies
-- one into an executable connection snapshot.
CREATE TABLE mcp_connection_tool_snapshots (
  connection_id        TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  stable_tool_id       TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  title                TEXT,
  description          TEXT,
  input_schema_json    TEXT NOT NULL,
  input_schema_sha256  TEXT NOT NULL CHECK (length(input_schema_sha256) = 64),
  output_schema_json   TEXT,
  output_schema_sha256 TEXT CHECK (output_schema_sha256 IS NULL OR length(output_schema_sha256) = 64),
  effect                TEXT NOT NULL CHECK (effect = 'external_read'),
  reviewed_at           INTEGER NOT NULL,
  PRIMARY KEY (connection_id, stable_tool_id),
  UNIQUE (connection_id, tool_name)
);

-- OAuth client state, PKCE verifiers, client registrations, and tokens share
-- one encrypted key/value authority. `ciphertext` is always AES-256-GCM data.
CREATE TABLE mcp_oauth_storage (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, storage_key)
);
