-- Add trigger configuration to automations
ALTER TABLE automations ADD COLUMN event_type TEXT;
ALTER TABLE automations ADD COLUMN trigger_config TEXT;
ALTER TABLE automations ADD COLUMN trigger_auth_data TEXT;

-- Add trigger_key and concurrency_key to automation_runs
ALTER TABLE automation_runs ADD COLUMN trigger_key TEXT;
ALTER TABLE automation_runs ADD COLUMN concurrency_key TEXT;

-- Index for event matching: find automations by repo + trigger type + event type
CREATE INDEX IF NOT EXISTS idx_automations_event_match
  ON automations (repo_owner, repo_name, trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type IN ('github_event', 'linear_event');

-- Index for Sentry event matching (no repo in the query)
CREATE INDEX IF NOT EXISTS idx_automations_sentry_match
  ON automations (trigger_type, event_type)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'sentry';

-- Unique index for event-driven run dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_trigger_key
  ON automation_runs (automation_id, trigger_key)
  WHERE trigger_key IS NOT NULL;

-- Index for per-event concurrency checks
CREATE INDEX IF NOT EXISTS idx_runs_concurrency
  ON automation_runs (automation_id, concurrency_key, status)
  WHERE concurrency_key IS NOT NULL AND status IN ('starting', 'running');
