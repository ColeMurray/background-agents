-- Reporting a failed run does not establish that its session stopped executing.
ALTER TABLE automation_runs ADD COLUMN execution_unresolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN execution_recovery_reason TEXT;
ALTER TABLE automation_runs ADD COLUMN execution_checked_at INTEGER;
-- A completed earlier turn cannot release admission while a follow-up enqueue is in flight.
ALTER TABLE automation_runs ADD COLUMN execution_launch_id TEXT;

-- Existing failed sessions may have been terminalized by the old bookkeeping-only sweep.
UPDATE automation_runs SET execution_unresolved = 1
WHERE session_id IS NOT NULL AND status IN ('running', 'failed');

CREATE INDEX idx_runs_execution_recovery
ON automation_runs(execution_checked_at, created_at)
WHERE status = 'running' OR execution_unresolved = 1;
