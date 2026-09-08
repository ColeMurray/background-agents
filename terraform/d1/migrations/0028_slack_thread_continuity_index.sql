-- Backs getLatestSteerableRunForThread: the most recent run with a session for a
-- thread's concurrency key, any status, within a time window. Powers Slack
-- thread-session continuity (a reply continues the same session after the run
-- completes). Partial on session_id so skipped rows (session_id NULL) are excluded.
CREATE INDEX IF NOT EXISTS idx_runs_thread_continuity
  ON automation_runs (automation_id, concurrency_key, created_at DESC)
  WHERE concurrency_key IS NOT NULL AND session_id IS NOT NULL;
