-- Give every automation run the execution deadline its own session was
-- launched with.
--
-- The recovery sweep used to reap any run still 'running' 90 minutes after
-- started_at. That number was a scheduler-local constant no operator could
-- see, and it ignored `sandboxTimeoutMs` — the setting that decides both how
-- long a session may process one message and how long its sandbox lives. A
-- deployment that raised the sandbox timeout therefore had its runs marked
-- 'execution_timeout' while the sessions behind them were still working, and
-- the success callback that arrived later was dropped as a terminal-run
-- transition.
--
-- Schema only, deliberately. A row's launch-time budget is not recoverable
-- from SQL, so any value guessed here could land before a deadline the run was
-- legitimately launched under. Rows that predate the column — and the ones a
-- pre-0079 worker claims between this migration and its own replacement —
-- keep a NULL deadline, and the sweep holds those to the deployment-default
-- deadline measured from started_at.

ALTER TABLE automation_runs ADD COLUMN execution_deadline_at INTEGER;

-- The sweep now orders and filters on the deadline, so its partial index has
-- to follow. Keep `status = 'running'` a literal (see migration 0024): a bound
-- parameter makes the planner skip the partial index and scan the whole
-- append-only table.
DROP INDEX IF EXISTS idx_runs_timeout_sweep;

CREATE INDEX IF NOT EXISTS idx_runs_timeout_sweep
  ON automation_runs (execution_deadline_at)
  WHERE status = 'running';
