ALTER TABLE users ADD COLUMN suspended_at INTEGER;

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  CHECK (
    (is_system = 1 AND key IS NOT NULL AND (
      (id = 'role_builtin_owner' AND key = 'owner')
      OR (id = 'role_builtin_administrator' AND key = 'administrator')
      OR (id = 'role_builtin_member' AND key = 'member')
      OR (id = 'role_builtin_viewer' AND key = 'viewer')
    ))
    OR (is_system = 0 AND key IS NULL AND id NOT IN (
      'role_builtin_owner',
      'role_builtin_administrator',
      'role_builtin_member',
      'role_builtin_viewer'
    ))
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
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT
);

CREATE TABLE authorization_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  actor_user_id_snapshot TEXT,
  actor_service_snapshot TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  target_user_id_snapshot TEXT,
  reason_code TEXT NOT NULL
);

CREATE INDEX idx_role_assignments_role ON user_role_assignments(role_id, user_id);

INSERT INTO roles (
  id, key, name, normalized_name, description, is_system
) VALUES
  ('role_builtin_owner', 'owner', 'Owner', 'owner', 'Full workspace control', 1),
  ('role_builtin_administrator', 'administrator', 'Administrator', 'administrator', 'Operational administration without ownership transfer', 1),
  ('role_builtin_member', 'member', 'Member', 'member', 'Session and automation collaboration', 1),
  ('role_builtin_viewer', 'viewer', 'Viewer', 'viewer', 'Read-only workspace visibility', 1);

INSERT INTO user_role_assignments (user_id, role_id)
SELECT id, 'role_builtin_administrator' FROM users;

CREATE TRIGGER assign_default_role_after_user_insert
AFTER INSERT ON users
BEGIN
  INSERT INTO user_role_assignments (user_id, role_id)
  VALUES (NEW.id, 'role_builtin_member')
  ON CONFLICT(user_id) DO NOTHING;
END;

UPDATE automations
SET user_id = (
  SELECT identity.user_id
  FROM user_identities identity
  WHERE identity.provider = 'github'
    AND identity.provider_user_id = automations.created_by
)
WHERE user_id IS NULL
  AND created_by <> 'anonymous';
