-- Code-server tunnel URL and password on the sandbox table.
-- Both URL and password rotate on every wake/restore.
ALTER TABLE sandbox ADD COLUMN code_server_url TEXT;
ALTER TABLE sandbox ADD COLUMN code_server_password TEXT;
