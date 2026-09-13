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

ALTER TABLE automation_runs ADD COLUMN execution_deadline_at INTEGER;

-- Rows already in flight predate the column. Give them a flat three-hour
-- deadline from launch: twice the 90 minutes they were launched under, so the
-- deploy itself is never the reason a run is reaped sooner than it would have
-- been. It is a one-time floor, not the per-session budget the sweep uses from
-- now on — a run launched before the deploy with a larger sandbox timeout can
-- still be reaped at three hours, once, which is accepted over holding a dead
-- run's automation for the full budget. Rows the old worker claims after this
-- backfill and before it is replaced stay NULL; the sweep holds those to the
-- deployment-default deadline from started_at.
UPDATE automation_runs
   SET execution_deadline_at = started_at + 10800000
 WHERE status = 'running'
   AND started_at IS NOT NULL
   AND execution_deadline_at IS NULL;

-- The sweep now orders and filters on the deadline, so its partial index has
-- to follow. Keep `status = 'running'` a literal (see migration 0024): a bound
-- parameter makes the planner skip the partial index and scan the whole
-- append-only table.
DROP INDEX IF EXISTS idx_runs_timeout_sweep;

CREATE INDEX IF NOT EXISTS idx_runs_timeout_sweep
  ON automation_runs (execution_deadline_at)
  WHERE status = 'running';
