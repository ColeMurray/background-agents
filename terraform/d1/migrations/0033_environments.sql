-- Environments: a named, prebuildable repository set (the Phase-2 launch unit).
--
-- An environment bundles 1..MAX_TARGET_REPOSITORIES member repositories in
-- position order plus its own secrets, and (once prebuild lands) its own image
-- builds. Sessions created from an environment snapshot its members into
-- session_repositories and record provenance in sessions.environment_id; the
-- environment can later be edited or deleted without affecting those sessions.
--
-- Cascade model: environment_repositories and environment_secrets are owned
-- children declared with ON DELETE CASCADE (matching session_repositories,
-- 0032), so deleting an environment reclaims them. environment_images is
-- deliberately FK-less — DELETE supersedes its rows so the reaper can still
-- delete the provider artifacts — and sessions.environment_id is FK-less so a
-- session keeps a benignly dangling id after its source environment is gone.

CREATE TABLE environments (
  id               TEXT PRIMARY KEY,            -- env_<id>
  name             TEXT NOT NULL,
  description      TEXT,
  prebuild_enabled INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Names are unique case-insensitively (they are user-editable display labels;
-- the stable env_<id> is the reference used by Slack/Linear targets, §7.5).
CREATE UNIQUE INDEX idx_environments_name ON environments (lower(name));

CREATE TABLE environment_repositories (
  environment_id TEXT NOT NULL,
  position       INTEGER NOT NULL,
  repo_owner     TEXT NOT NULL,
  repo_name      TEXT NOT NULL,
  repo_id        INTEGER,
  base_branch    TEXT NOT NULL,
  PRIMARY KEY (environment_id, repo_owner, repo_name),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE TABLE environment_secrets (          -- mirrors repo_secrets (0001)
  environment_id  TEXT NOT NULL,
  key             TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE TABLE environment_images (           -- generalizes repo_images (0009/0022/0023)
  id                    TEXT PRIMARY KEY,
  environment_id        TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'modal',
  provider_image_id     TEXT,
  members_fingerprint   TEXT NOT NULL,      -- hash over ordered (owner, name, base_branch)
  member_shas           TEXT NOT NULL,      -- JSON [{repoOwner, repoName, baseSha}]
  runtime_version       TEXT NOT NULL,      -- SANDBOX_VERSION at build (§7.3)
  status                TEXT NOT NULL DEFAULT 'building',  -- building|ready|failed|superseded
  build_duration_seconds REAL,
  error_message         TEXT,
  provider_session_id   TEXT,               -- provider-callback parity with 0023
  callback_token_hash   TEXT,
  callback_token_expires_at INTEGER,
  callback_token_used_at    INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_environment_images_env_status ON environment_images (environment_id, status, created_at);

-- Snapshot provenance for sessions created from an environment; no FK so a
-- deleted environment leaves the column dangling harmlessly. Written by PR-9.
ALTER TABLE sessions ADD COLUMN environment_id TEXT;

-- Reserved for the shared-workspace automation mode (§13.3); unused until then.
ALTER TABLE automations ADD COLUMN environment_id TEXT;
