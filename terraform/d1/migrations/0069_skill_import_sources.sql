-- Provenance for managed skills imported from a source-control repository.
--
-- One row per revision produced by an import. Editor-authored revisions have
-- no row, so a skill's recorded source is the most recent import and survives
-- later hand edits — which is what re-import must follow.

CREATE TABLE skill_import_sources (
  revision_id   TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  repo_owner    TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  -- NULL when the importer accepted the repository's default branch.
  requested_ref TEXT,
  resolved_ref  TEXT NOT NULL,
  -- Commit the content was read at; pins a moving ref to immutable bytes.
  commit_sha    TEXT NOT NULL,
  -- NULL when the skill is the repository root.
  subdirectory  TEXT,
  -- Digest of the bytes read upstream. Distinct from skill_revisions
  -- .revision_sha256, which covers the regenerated SKILL.md.
  source_sha256 TEXT NOT NULL,
  imported_at   INTEGER NOT NULL,
  FOREIGN KEY (revision_id, skill_id) REFERENCES skill_revisions(id, skill_id) ON DELETE CASCADE
);

CREATE INDEX idx_skill_import_sources_skill
  ON skill_import_sources (skill_id, imported_at DESC);
