-- Drop the per-automation hourly run cap. The max-runs-per-hour feature was
-- removed: the scheduler no longer rate-limits slack_event triggers, leaving the
-- per-thread concurrency guard as the backstop. The column is unindexed, so the
-- drop is clean.
--
-- 0026 (already applied) added this column; never edit it — the drop must be its
-- own migration.
ALTER TABLE automations DROP COLUMN max_runs_per_hour;
