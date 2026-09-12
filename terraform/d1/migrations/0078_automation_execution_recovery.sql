ALTER TABLE automation_runs ADD COLUMN execution_unresolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN execution_recovery_reason TEXT;
ALTER TABLE automation_runs ADD COLUMN execution_checked_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN execution_launch_id TEXT;
ALTER TABLE automation_runs ADD COLUMN execution_admission_deadline_ms INTEGER;

UPDATE automation_runs
SET execution_unresolved = 1,
    execution_recovery_reason = 'migration_backfill'
WHERE session_id IS NOT NULL
  AND (
    status = 'running'
    OR (status = 'failed' AND failure_reason = 'execution_timeout')
  );

CREATE INDEX IF NOT EXISTS idx_runs_execution_recovery
ON automation_runs(execution_checked_at, created_at)
WHERE status = 'running' OR execution_unresolved = 1;
