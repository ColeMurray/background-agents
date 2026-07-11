-- PR lifecycle tracking: queryable authority record for pull requests created
-- by Open-Inspect sessions (design: 2026-07-09-pull-request-artifact-tracking-design.md §4).
--
-- D1 is the authority; the session DO's `pr` artifact is a live-view mirror.
-- One row per PR, keyed by the DO artifact id. Written best-effort at creation
-- and kept fresh by webhook + read-through upserts, all guarded by a monotonic
-- provider_updated_at check. No operational columns (no sync status, claims,
-- or generations) — every write path is a plain upsert.
--
-- No backfill: pre-feature PRs have no rows here; the first webhook or
-- read-through on view inserts them.

CREATE TABLE IF NOT EXISTS session_pull_requests (
  artifact_id            TEXT PRIMARY KEY,  -- matches the DO artifact id
  session_id             TEXT NOT NULL,
  repository_external_id TEXT,              -- stable provider repo id (canonical identity)
  repo_owner             TEXT NOT NULL,     -- mutable lookup/display (refreshed on rename)
  repo_name              TEXT NOT NULL,
  pr_number              INTEGER NOT NULL CHECK (pr_number > 0),
  url                    TEXT NOT NULL,
  lifecycle_state        TEXT NOT NULL CHECK (lifecycle_state IN ('open', 'closed', 'merged')),
  is_draft               INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
  head_branch            TEXT NOT NULL,
  base_branch            TEXT NOT NULL,
  head_sha               TEXT,
  provider_updated_at    INTEGER,           -- provider's updated_at (epoch ms); monotonic guard source
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  -- Shared-contract invariant: draft is only meaningful while open. Enforced
  -- at the authority boundary so no writer can persist a terminal draft.
  CONSTRAINT chk_spr_draft_only_while_open CHECK (lifecycle_state = 'open' OR is_draft = 0),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Canonical identity lookup. Partial: legacy rows without an external id are
-- found via the store's owner/name fallback arm (getByIdentity) and are
-- upgraded in place on first provider read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spr_external_identity
  ON session_pull_requests (repository_external_id, pr_number)
  WHERE repository_external_id IS NOT NULL;

-- Uniqueness guard + fallback lookup for rows that predate external-id
-- capture (e.g. branch-derived webhook inserts, whose events carry no repo id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_spr_legacy_identity
  ON session_pull_requests (repo_owner, repo_name, pr_number)
  WHERE repository_external_id IS NULL;

-- Serves per-session reads and the grouped session-list summary.
CREATE INDEX IF NOT EXISTS idx_spr_session
  ON session_pull_requests (session_id);
