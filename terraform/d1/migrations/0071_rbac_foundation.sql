ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'active'
  CHECK (access_status IN ('active', 'suspended'));
ALTER TABLE users ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN last_authorization_mutation_id TEXT;

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  last_mutation_id TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (is_system = 1 AND key IN ('owner', 'administrator', 'member', 'viewer'))
    OR (is_system = 0 AND key IS NULL)
  )
);

-- Custom-role grants only; protected built-in grants are code-owned.
CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_assignments (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at INTEGER NOT NULL
);

CREATE TABLE workspace_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at INTEGER NOT NULL,
  assignment_completed_at INTEGER
);

CREATE TABLE rbac_migration_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  assignments_completed_at INTEGER NOT NULL
);

CREATE TABLE authorization_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  actor_user_id_snapshot TEXT,
  actor_service_snapshot TEXT,
  actor_provider_snapshot TEXT,
  actor_provider_user_id_snapshot TEXT,
  authorization_version INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  target_user_id_snapshot TEXT,
  decision_outcome TEXT NOT NULL CHECK (decision_outcome IN ('allowed', 'denied')),
  operation_result TEXT CHECK (operation_result IN ('pending', 'succeeded', 'failed')),
  reason_code TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE privileged_operation_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session_access (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('creator', 'participant')),
  state TEXT NOT NULL CHECK (state IN ('pending_add', 'active', 'revoking')),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX idx_role_assignments_role ON user_role_assignments(role_id, user_id);
CREATE INDEX idx_authorization_audit_time
  ON authorization_audit_events(occurred_at DESC, id DESC);
CREATE INDEX idx_authorization_audit_actor
  ON authorization_audit_events(actor_user_id_snapshot, occurred_at DESC);
CREATE INDEX idx_privileged_outbox_due
  ON privileged_operation_outbox(state, next_attempt_at);
CREATE INDEX idx_session_access_user
  ON session_access(user_id, state, session_id);

CREATE TRIGGER assign_default_role_after_user_insert
AFTER INSERT ON users
WHEN EXISTS (SELECT 1 FROM rbac_migration_state WHERE singleton = 1)
BEGIN
  INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
  VALUES (NEW.id, 'role_builtin_member', NULL, unixepoch() * 1000)
  ON CONFLICT(user_id) DO NOTHING;
END;

INSERT INTO roles (
  id, key, name, normalized_name, description, is_system, revision, created_at, updated_at
) VALUES
  ('role_builtin_owner', 'owner', 'Owner', 'owner', 'Full workspace control', 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('role_builtin_administrator', 'administrator', 'Administrator', 'administrator', 'Operational administration without ownership transfer', 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('role_builtin_member', 'member', 'Member', 'member', 'Session and automation collaboration', 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('role_builtin_viewer', 'viewer', 'Viewer', 'viewer', 'Read-only workspace visibility', 1, 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
SELECT id, 'role_builtin_administrator', NULL, unixepoch() * 1000 FROM users;

UPDATE automations
SET user_id = (
  SELECT identity.user_id
  FROM user_identities identity
  WHERE identity.provider = 'github'
    AND identity.provider_user_id = automations.created_by
)
WHERE user_id IS NULL
  AND created_by <> 'anonymous';

INSERT INTO session_access (session_id, user_id, relation, state, generation, created_at)
SELECT id, user_id, 'creator', 'active', 1, created_at
FROM sessions
WHERE user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id);

INSERT INTO rbac_migration_state (singleton, assignments_completed_at)
VALUES (1, unixepoch() * 1000);
