-- The workspace's rules for personal access tokens, edited by holders of
-- workspace.personal_access_tokens.manage. One row; every change bumps
-- `revision`, which an update must name, and writes a
-- workspace.personal_access_token_policy_updated audit event in the same
-- transaction.
--
-- NULL means "no workspace restriction beyond the system's own":
-- `max_lifetime_days` falls back to the system maximum, and
-- `allowed_permissions_json` (a JSON array of permission IDs) to every
-- permission a token may hold. The rules apply to existing tokens at
-- authentication, not only when a token is issued.
CREATE TABLE workspace_personal_access_token_policy (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  max_lifetime_days INTEGER,
  allowed_permissions_json TEXT,
  revision INTEGER NOT NULL,
  updated_at INTEGER,
  updated_by_user_id_snapshot TEXT
);

INSERT INTO workspace_personal_access_token_policy (id, enabled, revision) VALUES (1, 1, 0);
