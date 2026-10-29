-- Let a schedule automation hold more than one firing in flight at a time.
--
-- Until now the overlap guard was a boolean: a schedule or manual firing was
-- admitted only when the automation had NO active run. That made an
-- automation's throughput its cron cadence or one run per cadence, whichever
-- was slower — a queue-draining automation whose runs take longer than its
-- interval could never work more than one item at a time, however deep the
-- queue behind it.
--
-- The column turns that boolean into a bound. `1` reproduces the previous
-- behaviour exactly, which is why it is the default and why every existing
-- automation keeps it: raising the limit is an explicit decision about a
-- workload that is safe to run concurrently, never something a migration
-- infers.
--
-- The bound counts INVOCATIONS, not runs. A fan-out automation posts one
-- automation_runs row per target (up to ten), so a run-counted limit of 3
-- would refuse the second firing of a ten-repository automation while nothing
-- overlapping had happened. The scheduler's predicate therefore counts
-- DISTINCT invocation_id over the active runs.

ALTER TABLE automations ADD COLUMN max_concurrent_runs INTEGER NOT NULL DEFAULT 1;

-- The overlap predicate runs on every schedule and manual firing and counts
-- the automation's active runs. It is served by this index rather than by a
-- scan of the append-only runs table; `status` stays out of the key and in the
-- partial clause as literals (see migration 0024), so the planner keeps the
-- partial index instead of falling back to a full scan.
CREATE INDEX IF NOT EXISTS idx_runs_active_by_automation
  ON automation_runs (automation_id, invocation_id)
  WHERE status IN ('starting', 'running');
