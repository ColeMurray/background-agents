-- Add unique constraint on mcp_servers.name to prevent duplicate names
-- (duplicate names cause the last one to silently win in Python dict builds)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
