-- Old running rows are candidates for reconciliation, not proof that execution failed.
-- Persist the next probe time so healthy long-running sessions do not monopolize each sweep.
ALTER TABLE automation_runs ADD COLUMN reconciliation_due_at INTEGER;

UPDATE automation_runs
SET reconciliation_due_at = started_at + 5400000
WHERE status = 'running' AND started_at IS NOT NULL;

CREATE INDEX idx_runs_reconciliation_sweep
  ON automation_runs (reconciliation_due_at)
  WHERE status = 'running' AND reconciliation_due_at IS NOT NULL;
