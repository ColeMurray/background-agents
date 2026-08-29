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

CREATE TABLE browser_sign_in_evidence (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
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

WITH permissions(permission_id, administrator, member, viewer) AS (
  VALUES
    ('analytics.read', 1, 0, 0),
    ('audit.read', 1, 0, 0),
    ('automations.create', 1, 1, 0),
    ('automations.manage.any', 1, 0, 0),
    ('automations.manage.own', 1, 1, 0),
    ('automations.read', 1, 1, 1),
    ('automations.trigger.any', 1, 0, 0),
    ('automations.trigger.own', 1, 1, 0),
    ('commit_signing.manage', 1, 0, 0),
    ('environments.images.manage', 1, 0, 0),
    ('environments.manage', 1, 0, 0),
    ('environments.read', 1, 1, 1),
    ('environments.secrets.manage', 1, 0, 0),
    ('environments.settings.manage', 1, 0, 0),
    ('environments.use', 1, 1, 0),
    ('global_secrets.manage', 1, 0, 0),
    ('image_builds.read', 1, 0, 1),
    ('integrations.manage', 1, 0, 0),
    ('integrations.read', 1, 0, 0),
    ('mcp_servers.manage', 1, 0, 0),
    ('mcp_servers.read', 1, 1, 1),
    ('models.preferences.manage', 1, 0, 0),
    ('provider_accounts.manage', 1, 0, 0),
    ('provider_accounts.read', 1, 1, 0),
    ('repositories.images.manage', 1, 0, 0),
    ('repositories.read', 1, 1, 1),
    ('repositories.secrets.manage', 1, 0, 0),
    ('repositories.settings.manage', 1, 0, 0),
    ('repositories.use', 1, 1, 0),
    ('scm_settings.manage', 1, 0, 0),
    ('sessions.collaborate.any', 1, 0, 0),
    ('sessions.collaborate.own', 1, 1, 0),
    ('sessions.create', 1, 1, 0),
    ('sessions.delete.any', 1, 0, 0),
    ('sessions.delete.own', 1, 1, 0),
    ('sessions.lifecycle.any', 1, 0, 0),
    ('sessions.lifecycle.own', 1, 1, 0),
    ('sessions.participants.manage.any', 1, 0, 0),
    ('sessions.participants.manage.own', 1, 1, 0),
    ('sessions.read.any', 1, 0, 1),
    ('sessions.read.own', 1, 1, 0),
    ('sessions.sandbox_access.any', 1, 0, 0),
    ('sessions.sandbox_access.own', 1, 1, 0),
    ('skill_profiles.manage_own', 1, 1, 1),
    ('skills.manage', 1, 0, 0),
    ('skills.read', 1, 1, 1),
    ('workspace.members.manage', 1, 0, 0),
    ('workspace.members.read', 1, 0, 0),
    ('workspace.read', 1, 1, 1),
    ('workspace.roles.manage', 1, 0, 0),
    ('workspace.roles.read', 1, 0, 0),
    ('workspace.transfer_ownership', 0, 0, 0)
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_builtin_owner', permission_id FROM permissions
UNION ALL
SELECT 'role_builtin_administrator', permission_id FROM permissions WHERE administrator = 1
UNION ALL
SELECT 'role_builtin_member', permission_id FROM permissions WHERE member = 1
UNION ALL
SELECT 'role_builtin_viewer', permission_id FROM permissions WHERE viewer = 1;

INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
SELECT id, 'role_builtin_administrator', NULL, unixepoch() * 1000 FROM users;

INSERT INTO session_access (session_id, user_id, relation, state, generation, created_at)
SELECT id, user_id, 'creator', 'active', 1, created_at
FROM sessions
WHERE user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id);

INSERT INTO rbac_migration_state (singleton, assignments_completed_at)
VALUES (1, unixepoch() * 1000);
