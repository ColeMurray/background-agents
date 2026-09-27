-- Teams establish ownership and membership without changing access decisions.
--
-- The default team represents the existing single-workspace behavior. Nullable
-- owner foreign keys allow older Workers to write during the migration deploy
-- window; application writes provide an explicit owner and reads treat a NULL
-- from that window as the default team. A later backfill catches those writes.
-- The timestamp below records the authoring time in epoch milliseconds.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  join_policy TEXT NOT NULL DEFAULT 'invite_only' CHECK (join_policy IN ('open', 'invite_only')),
  auto_join INTEGER NOT NULL DEFAULT 0 CHECK (auto_join IN (0, 1)),
  default_visibility TEXT NOT NULL DEFAULT 'team' CHECK (default_visibility IN ('team', 'workspace', 'private')),
  default_environment_id TEXT,
  grants_version INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_teams_default ON teams(is_default) WHERE is_default = 1;

CREATE TABLE team_memberships (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_join', 'github_team')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_memberships_user ON team_memberships(user_id, team_id);

CREATE TABLE team_repository_grants (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('installation', 'repository')),
  repo_external_id INTEGER,
  repo_owner TEXT,
  repo_name TEXT,
  webhook_home INTEGER NOT NULL DEFAULT 0 CHECK (webhook_home IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((grant_kind = 'installation' AND repo_external_id IS NULL)
      OR (grant_kind = 'repository' AND repo_external_id IS NOT NULL
          AND repo_owner IS NOT NULL AND repo_name IS NOT NULL))
);
CREATE UNIQUE INDEX idx_team_grants_installation ON team_repository_grants(team_id) WHERE grant_kind = 'installation';
CREATE UNIQUE INDEX idx_team_grants_repository ON team_repository_grants(team_id, repo_external_id) WHERE grant_kind = 'repository';
CREATE UNIQUE INDEX idx_team_grants_webhook_home ON team_repository_grants(repo_external_id) WHERE webhook_home = 1 AND grant_kind = 'repository';
CREATE UNIQUE INDEX idx_team_grants_webhook_home_installation ON team_repository_grants(grant_kind) WHERE webhook_home = 1 AND grant_kind = 'installation';
CREATE INDEX idx_team_grants_repo ON team_repository_grants(repo_external_id, team_id);

CREATE TABLE team_channel_bindings (
  provider TEXT NOT NULL CHECK (provider IN ('slack', 'linear')),
  external_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'source' CHECK (kind IN ('primary', 'source')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE UNIQUE INDEX idx_team_bindings_primary ON team_channel_bindings(team_id, provider) WHERE kind = 'primary';

CREATE TABLE team_secrets (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, key)
);

CREATE TABLE session_collaborators (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX idx_session_collaborators_user ON session_collaborators(user_id, session_id);

INSERT INTO teams (id, slug, name, description, is_default, join_policy, auto_join, default_visibility,
  grants_version, created_at, updated_at)
VALUES ('team_default', 'default', 'Workspace', NULL, 1, 'open', 1, 'team', 0, 1790495974810, 1790495974810);

INSERT INTO team_memberships (team_id, user_id, role, source, created_at)
SELECT 'team_default', u.id,
  CASE WHEN ura.role_id = 'role_builtin_owner' THEN 'lead' ELSE 'member' END,
  'manual', 1790495974810
FROM users u LEFT JOIN user_role_assignments ura ON ura.user_id = u.id;

INSERT INTO team_repository_grants (id, team_id, grant_kind, webhook_home, created_at)
VALUES ('tgrant_default_installation', 'team_default', 'installation', 1, 1790495974810);

ALTER TABLE sessions ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'workspace', 'private'));
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE automations ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE environments ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE authorization_audit_events ADD COLUMN team_id TEXT;

UPDATE sessions SET owner_team_id = 'team_default' WHERE owner_team_id IS NULL;
UPDATE automations SET owner_team_id = 'team_default' WHERE owner_team_id IS NULL;
UPDATE environments SET owner_team_id = 'team_default' WHERE owner_team_id IS NULL;

CREATE INDEX idx_sessions_owner_team ON sessions(owner_team_id, status, updated_at DESC);
CREATE INDEX idx_sessions_owner_team_visibility ON sessions(owner_team_id, visibility, updated_at DESC);
CREATE INDEX idx_audit_events_team ON authorization_audit_events(team_id, occurred_at DESC, id DESC);
DROP INDEX idx_environments_name;
CREATE UNIQUE INDEX idx_environments_name ON environments (owner_team_id, lower(name));
