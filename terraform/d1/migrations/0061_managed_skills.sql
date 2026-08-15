-- Installation-wide managed skills, immutable content revisions, personal
-- profiles, and per-session pinned manifests.

CREATE TABLE skills_catalog_state (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL DEFAULT 0
);
INSERT INTO skills_catalog_state (singleton, generation) VALUES (1, 0);

CREATE TABLE skills (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  current_revision_id TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  deleted_at          INTEGER,
  created_by          TEXT NOT NULL,
  updated_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_skills_name ON skills (lower(name));

CREATE TABLE skill_revisions (
  id               TEXT PRIMARY KEY,
  skill_id         TEXT NOT NULL,
  revision_number  INTEGER NOT NULL,
  revision_sha256  TEXT NOT NULL,
  description      TEXT NOT NULL,
  body             TEXT NOT NULL,
  license          TEXT,
  compatibility    TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  total_bytes      INTEGER NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE (skill_id, revision_number),
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_skill_revisions_identity ON skill_revisions (id, skill_id);
CREATE INDEX idx_skill_revisions_skill ON skill_revisions (skill_id, revision_number DESC);

CREATE TABLE skill_revision_files (
  revision_id    TEXT NOT NULL,
  path           TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  executable     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (revision_id, path),
  FOREIGN KEY (revision_id) REFERENCES skill_revisions(id) ON DELETE CASCADE
);

CREATE TABLE skill_assignments (
  id             TEXT PRIMARY KEY,
  skill_id       TEXT NOT NULL,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('global', 'repository', 'environment')),
  repo_owner     TEXT,
  repo_name      TEXT,
  environment_id TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CHECK (
    (scope_type = 'global' AND repo_owner IS NULL AND repo_name IS NULL AND environment_id IS NULL)
    OR (scope_type = 'repository' AND repo_owner IS NOT NULL AND repo_name IS NOT NULL AND environment_id IS NULL)
    OR (scope_type = 'environment' AND repo_owner IS NULL AND repo_name IS NULL AND environment_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_skill_assignments_global
  ON skill_assignments (skill_id) WHERE scope_type = 'global';
CREATE UNIQUE INDEX idx_skill_assignments_repository
  ON skill_assignments (skill_id, lower(repo_owner), lower(repo_name)) WHERE scope_type = 'repository';
CREATE UNIQUE INDEX idx_skill_assignments_environment
  ON skill_assignments (skill_id, environment_id) WHERE scope_type = 'environment';

-- Enforce the circular current-revision relationship when the pointer changes.
CREATE TRIGGER skills_current_revision_same_skill
BEFORE UPDATE OF current_revision_id ON skills
WHEN NEW.current_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM skill_revisions
    WHERE id = NEW.current_revision_id AND skill_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current revision must belong to skill');
END;

CREATE TRIGGER skills_current_revision_same_skill_insert
BEFORE INSERT ON skills
WHEN NEW.current_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM skill_revisions
    WHERE id = NEW.current_revision_id AND skill_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'current revision must belong to skill');
END;

-- Assignment rows can disappear through foreign-key cascades outside SkillStore.
-- Keep resolver stability database-owned for every write path.
CREATE TRIGGER skill_assignments_generation_insert
AFTER INSERT ON skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TRIGGER skill_assignments_generation_update
AFTER UPDATE ON skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TRIGGER skill_assignments_generation_delete
AFTER DELETE ON skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

-- Environment names are copied into assignment provenance during resolution.
CREATE TRIGGER skill_environment_name_generation
AFTER UPDATE OF name ON environments
WHEN OLD.name IS NOT NEW.name
  AND EXISTS (SELECT 1 FROM skill_assignments WHERE environment_id = NEW.id)
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TABLE skill_profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE skill_profile_items (
  profile_id TEXT NOT NULL,
  skill_id   TEXT NOT NULL,
  PRIMARY KEY (profile_id, skill_id),
  FOREIGN KEY (profile_id) REFERENCES skill_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE session_skill_manifests (
  session_id             TEXT PRIMARY KEY,
  selection_mode         TEXT NOT NULL CHECK (selection_mode IN ('all', 'none', 'profile')),
  profile_id             TEXT,
  profile_name           TEXT,
  resolver_version       INTEGER NOT NULL,
  manifest_sha256        TEXT NOT NULL,
  resolved_at            INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK (
    (selection_mode = 'profile' AND profile_id IS NOT NULL AND profile_name IS NOT NULL)
    OR (selection_mode IN ('all', 'none') AND profile_id IS NULL AND profile_name IS NULL)
  )
);

CREATE TABLE session_skill_revisions (
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  skill_id            TEXT NOT NULL,
  revision_id         TEXT NOT NULL,
  skill_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  revision_number     INTEGER NOT NULL,
  revision_sha256     TEXT NOT NULL,
  total_bytes         INTEGER NOT NULL,
  assignment_sources  TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id) REFERENCES session_skill_manifests(session_id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, skill_id) REFERENCES skill_revisions(id, skill_id) ON DELETE RESTRICT
);
