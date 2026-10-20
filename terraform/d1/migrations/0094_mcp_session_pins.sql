-- pi-feature: mcp
-- Session attachments for reviewed MCP connections, and a rotatable keyring.
--
-- A personal MCP connection is not available to a session until its owner
-- explicitly grants it. The grant names one session and one connection, and
-- records the catalog snapshot the grant was made against, so a later catalog
-- change cannot silently widen what the session may read.

CREATE TABLE mcp_session_pins (
  id                      TEXT PRIMARY KEY CHECK (id GLOB 'mcppin_*'),
  session_id              TEXT NOT NULL,
  connection_id           TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  -- The connection owner is the only account that may grant or revoke.
  owner_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- The catalog snapshot the grant was made against.
  catalog_snapshot_sha256 TEXT NOT NULL CHECK (length(catalog_snapshot_sha256) = 64),
  -- The reviewed read-only tools this grant exposes, as a JSON array of names.
  -- The payload is assembled in TypeScript and bound as a parameter, so the
  -- schema checks only its shape. The JSON functions are not portable.
  tool_names              TEXT NOT NULL CHECK (length(tool_names) > 2 AND tool_names LIKE '[%]'),
  status                  TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'revoking', 'revoked')),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (session_id, connection_id)
);

CREATE INDEX idx_mcp_session_pins_session
  ON mcp_session_pins(session_id, status, created_at DESC, id);

CREATE INDEX idx_mcp_session_pins_connection
  ON mcp_session_pins(connection_id, status, created_at DESC, id);

-- The MCP OAuth keyring. The active key encrypts new material; a retired key
-- stays readable so a rotation never strands an existing token.
CREATE TABLE mcp_oauth_keyring (
  key_id        TEXT PRIMARY KEY,
  -- AES-256-GCM raw key material, base64.
  key_material  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at    INTEGER NOT NULL,
  retired_at    INTEGER
);

CREATE UNIQUE INDEX idx_mcp_oauth_keyring_active
  ON mcp_oauth_keyring(status) WHERE status = 'active';
