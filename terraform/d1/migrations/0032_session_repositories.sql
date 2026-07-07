-- Multi-repo sessions: normalized repository membership for the session index.
--
-- One row per member repository, in position order (position 0 = primary).
-- The scalar sessions.repo_* columns stay authoritative for the primary
-- (list-created sessions mirror their first entry into them), so existing
-- filters and dashboards keep working unchanged; this table adds the full
-- member set for list hydration and by-repo lookups.
--
-- No backfill: pre-feature sessions have no rows here and readers synthesize
-- a one-entry list from the scalar columns.

CREATE TABLE IF NOT EXISTS session_repositories (
  session_id  TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  repo_owner  TEXT    NOT NULL,
  repo_name   TEXT    NOT NULL,
  repo_id     INTEGER,
  base_branch TEXT    NOT NULL,
  PRIMARY KEY (session_id, repo_owner, repo_name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Serves "sessions touching repo X" lookups across the member set.
CREATE INDEX IF NOT EXISTS idx_session_repositories_repo
  ON session_repositories (repo_owner, repo_name, session_id);
