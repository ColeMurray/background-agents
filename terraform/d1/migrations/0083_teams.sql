-- Teams are opt-in overlays over existing workspace-level ownership.
-- A NULL owner_team_id remains workspace-owned across the deploy window; no
-- team or membership is created for existing users or resources. Visibility
-- defaults to workspace and only a team-owned session may be team-visible.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  join_policy TEXT NOT NULL DEFAULT 'invite_only' CHECK (join_policy IN ('open', 'invite_only')),
  default_visibility TEXT NOT NULL DEFAULT 'team' CHECK (default_visibility IN ('team', 'workspace', 'private')),
  default_environment_id TEXT,
  grants_version INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE team_memberships (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github_team')),
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
  created_at INTEGER NOT NULL,
  CHECK ((grant_kind = 'installation' AND repo_external_id IS NULL)
      OR (grant_kind = 'repository' AND repo_external_id IS NOT NULL
          AND repo_owner IS NOT NULL AND repo_name IS NOT NULL))
);
CREATE UNIQUE INDEX idx_team_grants_installation ON team_repository_grants(team_id) WHERE grant_kind = 'installation';
CREATE UNIQUE INDEX idx_team_grants_repository ON team_repository_grants(team_id, repo_external_id) WHERE grant_kind = 'repository';
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

ALTER TABLE sessions ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('team', 'workspace', 'private') AND (visibility != 'team' OR owner_team_id IS NOT NULL));
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE automations ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE environments ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT;
ALTER TABLE authorization_audit_events ADD COLUMN team_id TEXT;

CREATE INDEX idx_sessions_owner_team ON sessions(owner_team_id, status, updated_at DESC);
CREATE INDEX idx_sessions_owner_team_visibility ON sessions(owner_team_id, visibility, updated_at DESC);
CREATE INDEX idx_audit_events_team ON authorization_audit_events(team_id, occurred_at DESC, id DESC);
DROP INDEX idx_environments_name;
CREATE UNIQUE INDEX idx_environments_name ON environments (COALESCE(owner_team_id, ''), lower(name));
