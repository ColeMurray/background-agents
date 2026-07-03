-- Multi-repo automations: normalized repository selection + first-class
-- invocation records.
--
-- Model: every firing of an automation is one automation_invocations row. A
-- skipped firing is a childless invocation carrying skip_reason; a started
-- firing has one automation_runs child per repository (a repo-less automation
-- has one null-repo child). Invocation status is DERIVED from its children —
-- never stored. automation_runs keeps its shipped meaning: the per-repository,
-- session-linked unit.
--
-- Every backfill statement below is guarded (NOT EXISTS / IS NULL) so the file
-- doubles as the idempotent roll-forward repair script: after a rollback
-- window in which old code wrote scalar-only automations or invocation-less
-- runs, re-running the INSERT/UPDATE statements repairs them.

-- ── 1. Repository selection ────────────────────────────────────────────────
-- Single source of truth for an automation's repositories (0..N rows). The
-- scalar automations.repo_* columns are frozen after this migration: new code
-- reads only this table and keeps a single transitional dual-write of the
-- scalars for 0/1-repository automations (rollback cover) until the columns
-- are dropped in a later contract migration.

CREATE TABLE IF NOT EXISTS automation_repositories (
  automation_id TEXT    NOT NULL,
  repo_owner    TEXT    NOT NULL,
  repo_name     TEXT    NOT NULL,
  repo_id       INTEGER,
  base_branch   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, repo_owner, repo_name),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE INDEX IF NOT EXISTS idx_automation_repositories_repo
  ON automation_repositories (repo_owner, repo_name);

-- Backfill from the scalar columns. TRIM/LOWER matches the write-side
-- normalization (normalizeOptionalRepositoryPair in @open-inspect/shared);
-- NULLIF scrubs legacy blank values that predate it, and the pair guard skips
-- rows where scrubbing leaves only half a pair.
INSERT INTO automation_repositories
  (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
SELECT
  a.id,
  LOWER(TRIM(a.repo_owner)),
  LOWER(TRIM(a.repo_name)),
  a.repo_id,
  NULLIF(TRIM(COALESCE(a.base_branch, '')), ''),
  a.created_at,
  a.updated_at
FROM automations a
WHERE a.deleted_at IS NULL
  AND NULLIF(TRIM(COALESCE(a.repo_owner, '')), '') IS NOT NULL
  AND NULLIF(TRIM(COALESCE(a.repo_name, '')), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id
  );

-- ── 2. Invocations ─────────────────────────────────────────────────────────
-- Thin row: identity + firing-scoped keys + skip/bookkeeping. No status, no
-- expected_runs, no completed_at — all derived from children. trigger_key /
-- concurrency_key / trigger_metadata describe firings, not per-repo work, so
-- they live here (the matching automation_runs columns are frozen: new rows
-- leave them NULL).

CREATE TABLE IF NOT EXISTS automation_invocations (
  id                 TEXT    PRIMARY KEY,
  automation_id      TEXT    NOT NULL,
  source             TEXT    NOT NULL,      -- 'schedule' | 'manual' | 'event': provenance of this
                                            -- firing, distinct from automations.trigger_type (config)
  scheduled_at       INTEGER,               -- the cron slot; NULL unless source = 'schedule'
  trigger_key        TEXT,                  -- event dedup key
  concurrency_key    TEXT,                  -- per-key overlap scope for event firings
  trigger_metadata   TEXT,                  -- source-specific context (e.g. slack thread)
  skip_reason        TEXT,                  -- non-null ⇔ skipped firing (zero children)
  failure_counted_at INTEGER,               -- CAS anchor for auto-pause accounting
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (source <> 'schedule' OR scheduled_at IS NOT NULL),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

-- Cron double-fire dedup. Manual/event firings use fresh ids and NULL
-- scheduled_at, so they never collide here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_idempotency
  ON automation_invocations (automation_id, scheduled_at)
  WHERE source = 'schedule';

-- Event dedup, enforced atomically by the insert batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_trigger_key
  ON automation_invocations (automation_id, trigger_key)
  WHERE trigger_key IS NOT NULL;

-- Per-key active lookup (joins automation_runs for activeness).
CREATE INDEX IF NOT EXISTS idx_invocations_concurrency
  ON automation_invocations (automation_id, concurrency_key)
  WHERE concurrency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invocations_automation_created
  ON automation_invocations (automation_id, created_at DESC);

-- Serves the recovery sweep's "recent unfinalized invocations" arm.
CREATE INDEX IF NOT EXISTS idx_invocations_created
  ON automation_invocations (created_at DESC);

-- ── 3. Run linkage + repository snapshot ───────────────────────────────────
-- Snapshot columns are written at firing time from the resolved repository
-- set, so history never depends on the live selection (repo-set edits apply
-- from the next invocation; in-flight invocations complete against the set
-- they resolved).

ALTER TABLE automation_runs ADD COLUMN invocation_id TEXT;
ALTER TABLE automation_runs ADD COLUMN repo_owner TEXT;
ALTER TABLE automation_runs ADD COLUMN repo_name TEXT;
ALTER TABLE automation_runs ADD COLUMN repo_id INTEGER;
ALTER TABLE automation_runs ADD COLUMN base_branch TEXT;

-- ── 4. Backfill legacy history into invocations of 1 ───────────────────────
-- One invocation per existing run, reusing the run's id (distinct id spaces,
-- so no collision hazard). Source labeling: trigger_key marks event firings;
-- schedule and legacy manual firings are indistinguishable and both get
-- 'schedule' (documented, harmless — scheduled_at was NOT NULL on every
-- legacy run, so the CHECK holds). failure_counted_at is stamped on failed
-- rows so the recovery sweep's finalization arm does not re-count strikes
-- that the legacy accounting already took.
--
-- Idempotency-index precondition: idx_runs_idempotency has enforced
-- UNIQUE(automation_id, scheduled_at) across ALL legacy runs since migration
-- 0013, which is what lets this backfill satisfy idx_invocations_idempotency
-- for the rows labeled 'schedule'. Step 5 below drops that runs-side index,
-- so this ordering is load-bearing.
-- (IIF instead of CASE throughout this file: wrangler's migration splitter
-- treats a bare END as a compound-block terminator and would glue every
-- following statement into this one.)
INSERT INTO automation_invocations
  (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
   trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
SELECT
  r.id,
  r.automation_id,
  IIF(r.trigger_key IS NOT NULL, 'event', 'schedule'),
  IIF(r.trigger_key IS NOT NULL, NULL, r.scheduled_at),
  r.trigger_key,
  r.concurrency_key,
  r.trigger_run_metadata,
  r.skip_reason,
  IIF(r.status = 'failed', COALESCE(r.completed_at, r.created_at), NULL),
  r.created_at,
  r.created_at
FROM automation_runs r
WHERE r.invocation_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM automation_invocations ai WHERE ai.id = r.id);

UPDATE automation_runs SET invocation_id = id WHERE invocation_id IS NULL;
-- Post-condition: every run has invocation_id (app-enforced from here on;
-- SQLite cannot add NOT NULL without a rebuild).

-- Snapshot each run's repository from ITS SESSION, not from the automation
-- row — an automation retargeted since the run executed would otherwise
-- fabricate history. Runs without sessions (legacy skips, failed-before-
-- create) keep NULL snapshots, which renderers already tolerate. Sessions do
-- not store repo_id, so backfilled snapshots leave it NULL. Legacy sessions
-- may predate write-side normalization, so normalize + pair-guard here.
UPDATE automation_runs
SET
  repo_owner = IIF(norm.owner IS NULL OR norm.name IS NULL, NULL, norm.owner),
  repo_name = IIF(norm.owner IS NULL OR norm.name IS NULL, NULL, norm.name),
  base_branch = IIF(norm.owner IS NULL OR norm.name IS NULL, NULL, norm.branch)
FROM (
  SELECT
    s.id AS session_id,
    NULLIF(LOWER(TRIM(COALESCE(s.repo_owner, ''))), '') AS owner,
    NULLIF(LOWER(TRIM(COALESCE(s.repo_name, ''))), '') AS name,
    NULLIF(TRIM(COALESCE(s.base_branch, '')), '') AS branch
  FROM sessions s
) AS norm
WHERE automation_runs.session_id = norm.session_id
  AND automation_runs.repo_owner IS NULL;

-- ── 5. Index moves ─────────────────────────────────────────────────────────
-- Cron idempotency now lives on automation_invocations (see the precondition
-- note on step 4). The runs-side index must go: sibling children of one
-- invocation share (automation_id, scheduled_at) and would collide on it.
-- idx_runs_trigger_key stays until the scheduler event path writes
-- invocations (its dedup depends on it; new-pipeline children leave
-- trigger_key NULL, which the partial index ignores).
DROP INDEX IF EXISTS idx_runs_idempotency;

CREATE INDEX IF NOT EXISTS idx_runs_invocation
  ON automation_runs (invocation_id, created_at);

-- Carries the retry-model invariant: within one invocation, each repository
-- has at most one run. A future modeled retry is a NEW linked invocation,
-- never a second run here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_invocation_repo
  ON automation_runs (invocation_id, repo_owner, repo_name)
  WHERE repo_owner IS NOT NULL;
