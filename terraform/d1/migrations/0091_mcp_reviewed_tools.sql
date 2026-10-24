-- feature: mcp
-- The reviewed read-only catalogue of the deployment's shared MCP servers.
--
-- The core harness reads a shared server's tools from here: the review says
-- which tools exist, what they take, and that they are reads. A tool that is
-- not reviewed is not callable.
CREATE TABLE mcp_reviewed_tools (
  stable_tool_id       TEXT PRIMARY KEY,
  server_id            TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  server_revision      INTEGER NOT NULL CHECK (server_revision > 0),
  tool_name            TEXT NOT NULL,
  title                TEXT,
  description          TEXT,
  input_schema_json    TEXT NOT NULL,
  input_schema_sha256  TEXT NOT NULL CHECK (length(input_schema_sha256) = 64),
  output_schema_json   TEXT,
  output_schema_sha256 TEXT CHECK (output_schema_sha256 IS NULL OR length(output_schema_sha256) = 64),
  effect                TEXT NOT NULL CHECK (effect IN ('external_read', 'external_mutation')),
  reviewed_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at           INTEGER NOT NULL,
  UNIQUE (server_id, server_revision, tool_name)
);

-- Immutable executable catalog snapshot. Later review rows cannot widen an
-- already staged connection; a new connection is required for a new snapshot.
