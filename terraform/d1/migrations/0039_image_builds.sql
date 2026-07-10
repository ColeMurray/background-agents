-- image_builds: the unified prebuilt-image registry, generalizing
-- environment_images (0033/0034) to a scope — either an environment (ordered
-- repository set) or, once the repo scope lands, a single repository.
--
-- FK-less on purpose, same reasoning as 0033: deleting the owning entity
-- supersedes its rows rather than cascading, so the cleanup reaper can still
-- find and delete the provider-side artifacts after the entity is gone.
--
-- scope_kind is 'repo' | 'environment'; scope_id is a lowercase 'owner/name'
-- pair for repo scopes and an environment id for environment scopes.

CREATE TABLE image_builds (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'modal',
  provider_image_id TEXT,
  repositories_fingerprint TEXT NOT NULL,
  repository_shas TEXT NOT NULL,               -- JSON [{repoOwner, repoName, baseSha}]
  runtime_version TEXT NOT NULL,               -- SANDBOX_VERSION at build
  status TEXT NOT NULL DEFAULT 'building',     -- building|ready|failed|superseded
  build_duration_seconds REAL,
  error_message TEXT,
  provider_session_id TEXT,
  callback_token_hash TEXT,
  callback_token_expires_at INTEGER,
  callback_token_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_image_builds_scope_status
  ON image_builds (scope_kind, scope_id, status, created_at);

-- Copy environment rows verbatim: they already carry fingerprints, so
-- environment prebuild continuity is preserved across the migration.
INSERT INTO image_builds (
  id,
  scope_kind,
  scope_id,
  provider,
  provider_image_id,
  repositories_fingerprint,
  repository_shas,
  runtime_version,
  status,
  build_duration_seconds,
  error_message,
  provider_session_id,
  callback_token_hash,
  callback_token_expires_at,
  callback_token_used_at,
  created_at
)
SELECT
  id,
  'environment',
  environment_id,
  provider,
  provider_image_id,
  repositories_fingerprint,
  repository_shas,
  runtime_version,
  status,
  build_duration_seconds,
  error_message,
  provider_session_id,
  callback_token_hash,
  callback_token_expires_at,
  callback_token_used_at,
  created_at
FROM environment_images;

DROP TABLE environment_images;
