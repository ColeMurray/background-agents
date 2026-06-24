-- Replace idx_runs_automation_status with a partial index for the
-- getActiveRunForAutomation lookup. Its non-partial (automation_id, status) key
-- covered every status including the completed/failed/skipped rows that
-- dominate the append-only automation_runs table, so active-run concurrency
-- checks scanned dead rows and timed out under load. Mirrors idx_runs_concurrency
-- (migration 0015): the `status IN ('starting','running')` partial predicate
-- matches the query's `status IN ('starting','running')` filter, keeping the
-- index scoped to the small active subset. listRunsForAutomation uses
-- idx_runs_automation_created and getRunById uses the primary key, so nothing
-- else relied on the dropped index.

DROP INDEX IF EXISTS idx_runs_automation_status;

CREATE INDEX IF NOT EXISTS idx_runs_active_lookup
  ON automation_runs (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running');
