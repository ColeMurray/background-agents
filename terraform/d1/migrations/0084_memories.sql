-- Revisioned memory and pinned session context. Scope identities are retained
-- after target deletion so historical manifests do not block environment cleanup.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('personal', 'repository', 'environment')),
  owner_user_id TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  repo_id INTEGER,
  environment_id TEXT,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'directive')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'archived')),
  current_revision_id TEXT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_user_id TEXT,
  author_session_id TEXT,
  supersedes_memory_id TEXT REFERENCES memories(id),
  supersedes_revision_id TEXT,
  approved_at INTEGER,
  decided_by TEXT,
  archived_at INTEGER,
  archived_by TEXT,
  archive_reason TEXT,
  last_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_type = 'personal' AND owner_user_id IS NOT NULL AND repo_owner IS NULL AND repo_name IS NULL AND environment_id IS NULL)
    OR (scope_type = 'repository' AND owner_user_id IS NULL AND repo_owner IS NOT NULL AND repo_name IS NOT NULL AND environment_id IS NULL)
    OR (scope_type = 'environment' AND owner_user_id IS NULL AND repo_owner IS NULL AND repo_name IS NULL AND environment_id IS NOT NULL)
  ),
  CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR (status <> 'archived' AND archived_at IS NULL)),
  CHECK (author_kind = 'user' OR author_session_id IS NOT NULL)
);
CREATE INDEX idx_memories_personal ON memories(owner_user_id, status) WHERE scope_type = 'personal';
CREATE INDEX idx_memories_repository ON memories(lower(repo_owner), lower(repo_name), status) WHERE scope_type = 'repository';
CREATE INDEX idx_memories_environment ON memories(environment_id, status) WHERE scope_type = 'environment';
CREATE INDEX idx_memories_author_session ON memories(author_session_id, status);
CREATE INDEX idx_memories_supersedes ON memories(supersedes_memory_id);

CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'directive')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_user_id TEXT,
  author_session_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision_number),
  UNIQUE(id, memory_id)
);

CREATE TABLE memory_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  include_personal_memories INTEGER NOT NULL CHECK (include_personal_memories IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE session_memory_manifests (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  resolver_version INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  include_personal_memories INTEGER NOT NULL CHECK (include_personal_memories IN (0, 1)),
  personal_owner_user_id TEXT,
  personal_auto_save_eligible INTEGER NOT NULL DEFAULT 0 CHECK (personal_auto_save_eligible IN (0, 1)),
  directive_chars INTEGER NOT NULL,
  catalog_chars INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  truncated_count INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL
);
CREATE TABLE session_memory_items (
  session_id TEXT NOT NULL REFERENCES session_memory_manifests(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  inclusion TEXT NOT NULL CHECK (inclusion IN ('directive', 'catalog', 'truncated')),
  estimated_tokens INTEGER NOT NULL,
  PRIMARY KEY(session_id, memory_id),
  UNIQUE(session_id, position),
  FOREIGN KEY(revision_id, memory_id) REFERENCES memory_revisions(id, memory_id) ON DELETE RESTRICT
);
CREATE INDEX idx_session_memory_items_memory ON session_memory_items(memory_id, session_id);
