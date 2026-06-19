-- Replace idx_runs_active_status with per-status partial indexes for the recovery
-- sweeps. Its `status IN ('starting','running')` predicate is never matched by the
-- sweeps' `status = '...'` queries, so they full-scanned the append-only
-- automation_runs table and timed out as history grew. Bare-equality partials
-- match the queries and stay scoped to the small active subset.

DROP INDEX IF EXISTS idx_runs_active_status;

CREATE INDEX IF NOT EXISTS idx_runs_orphan_sweep
  ON automation_runs (created_at)
  WHERE status = 'starting';

CREATE INDEX IF NOT EXISTS idx_runs_timeout_sweep
  ON automation_runs (started_at)
  WHERE status = 'running';
