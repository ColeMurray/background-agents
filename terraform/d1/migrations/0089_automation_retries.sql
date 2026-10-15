ALTER TABLE automations ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries BETWEEN 0 AND 5);
ALTER TABLE automation_invocations ADD COLUMN retry_context TEXT;
ALTER TABLE automation_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE automation_runs ADD COLUMN retry_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN superseded_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN retry_of_run_id TEXT;
ALTER TABLE automation_runs ADD COLUMN target_resolved INTEGER NOT NULL DEFAULT 1;
ALTER TABLE automation_runs ADD COLUMN retry_withdrawn_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN completion_publication_claimed_at INTEGER;

DROP INDEX idx_runs_invocation_repo;
CREATE UNIQUE INDEX idx_runs_invocation_repo
  ON automation_runs (invocation_id, repo_owner, repo_name, attempt)
  WHERE repo_owner IS NOT NULL;
DROP INDEX idx_runs_invocation_environment;
CREATE UNIQUE INDEX idx_runs_invocation_environment
  ON automation_runs (invocation_id, environment_id, attempt)
  WHERE environment_id IS NOT NULL;
CREATE INDEX idx_runs_due_retry ON automation_runs (retry_at) WHERE status = 'retrying';
DROP INDEX idx_runs_active_lookup;
CREATE INDEX idx_runs_active_lookup ON automation_runs (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running', 'retrying');
CREATE UNIQUE INDEX idx_runs_retry_parent ON automation_runs (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;
