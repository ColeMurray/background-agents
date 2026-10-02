-- Projects are optional context hubs; Teams already added sessions.project_id.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                       -- proj_<id>
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  brief TEXT,                                -- markdown; length enforced in the store
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'shipped', 'archived')),
  shipped_at INTEGER,
  archived_at INTEGER,
  owner_team_id TEXT REFERENCES teams(id),                        -- NULL for workspace ownership
  owner_user_id TEXT NOT NULL,               -- creator; also manageable by the owning team lead
  default_environment_id TEXT,               -- FK-less, like sessions.environment_id
  default_repo_owner TEXT,
  default_repo_name TEXT,
  default_agent_profile_id TEXT,             -- Profiles hook; NULL until Profiles lands
  linear_project_id TEXT,
  linear_project_url TEXT,
  primary_slack_channel_id TEXT,
  status_summary TEXT,
  status_summary_source TEXT CHECK (status_summary_source IN ('user', 'agent')),
  status_summary_session_id TEXT,
  status_summary_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (default_environment_id IS NULL OR default_repo_owner IS NULL),
  CHECK ((default_repo_owner IS NULL) = (default_repo_name IS NULL))
);
CREATE UNIQUE INDEX idx_projects_slug ON projects(lower(slug));
CREATE INDEX idx_projects_team_status ON projects(owner_team_id, status, updated_at DESC);

CREATE TABLE project_context_sources (
  id TEXT PRIMARY KEY,                       -- pcs_<id>
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN
    ('linear_project', 'slack_channel', 'url', 'repo_doc', 'session', 'memory')),
  external_id_or_url TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL CHECK (role IN ('brief', 'decisions', 'tickets', 'channel', 'metrics', 'reference')),
  refresh_policy TEXT NOT NULL DEFAULT 'never' CHECK (refresh_policy IN ('never', 'manual', 'on_session_create')),
  provenance TEXT NOT NULL CHECK (provenance IN ('user', 'agent', 'import')),
  provenance_session_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'agent' CHECK (visibility IN ('agent', 'page_only')),
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, source_type, external_id_or_url)
);
CREATE INDEX idx_project_context_sources_project ON project_context_sources(project_id, position);

CREATE TABLE project_pins (
  id TEXT PRIMARY KEY,                       -- pin_<id>
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'link', 'artifact')),
  title TEXT NOT NULL,
  body TEXT,                                 -- decision markdown; length enforced in the store
  url TEXT,
  session_id TEXT,                           -- artifact pins
  artifact_id TEXT,                          -- artifact pins: the DO artifact id
  decided_at INTEGER,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind <> 'artifact' OR (session_id IS NOT NULL AND artifact_id IS NOT NULL)),
  CHECK (kind <> 'link' OR url IS NOT NULL)
);
CREATE INDEX idx_project_pins_project ON project_pins(project_id, kind, position);

CREATE TABLE session_project_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  injected_text TEXT NOT NULL,
  injected_bytes INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,               -- {briefSha256, decisionIds, sourceIds, truncated}; built in TypeScript
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_session_project_snapshots_project ON session_project_snapshots(project_id, created_at DESC);

ALTER TABLE automations ADD COLUMN project_id TEXT;
CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX idx_automations_project ON automations(project_id) WHERE project_id IS NOT NULL;
