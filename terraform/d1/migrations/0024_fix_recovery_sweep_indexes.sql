-- Fix the scheduler recovery-sweep indexes.
--
-- The recovery sweeps query a single status with a literal predicate:
--   getOrphanedStartingRuns: WHERE status = 'starting' AND created_at < ?
--   getTimedOutRunningRuns:  WHERE status = 'running'  AND started_at < ?
--
-- The previous index, idx_runs_active_status (status, created_at)
-- WHERE status IN ('starting','running'), was NEVER used by those queries:
-- SQLite (and therefore D1) cannot prove that `status = 'starting'` implies the
-- index's `status IN ('starting','running')` predicate, so each sweep fell back
-- to a full table SCAN of automation_runs. automation_runs is append-only, so as
-- run history grew the scan eventually exceeded D1's query time limit -> the
-- recovery sweep (and thus the whole scheduler tick) started timing out.
--
-- Bare-equality partial predicates match each query verbatim, so the planner
-- uses them. Because they are partial, each index only ever holds the small
-- active subset (rows in a terminal state are excluded), so they stay tiny and
-- fast regardless of how large the history grows.

DROP INDEX IF EXISTS idx_runs_active_status;

CREATE INDEX IF NOT EXISTS idx_runs_orphan_sweep
  ON automation_runs (created_at)
  WHERE status = 'starting';

CREATE INDEX IF NOT EXISTS idx_runs_timeout_sweep
  ON automation_runs (started_at)
  WHERE status = 'running';
