-- Scheduled runs whose launch fails before their prompt is sent can wait and
-- relaunch, up to the automation's max_retries. A waiting run keeps its row:
-- status 'retrying', with retry_at set and attempt counting launches.

-- The upper bound is MAX_AUTOMATION_RETRIES in @open-inspect/shared.
ALTER TABLE automations ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0
  CHECK (max_retries BETWEEN 0 AND 5);
ALTER TABLE automation_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE automation_runs ADD COLUMN retry_at INTEGER;

-- A waiting run holds its automation like an active one. The active-run
-- lookups list these statuses as ACTIVE_RUN_STATUSES_SQL in the automation
-- store; the predicate must match it for them to use this index.
DROP INDEX idx_runs_active_lookup;
CREATE INDEX idx_runs_active_lookup
  ON automation_runs (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running', 'retrying');

CREATE INDEX idx_runs_retry_due
  ON automation_runs (retry_at)
  WHERE status = 'retrying';
