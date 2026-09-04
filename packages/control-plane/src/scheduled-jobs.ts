/**
 * The control plane's scheduled jobs: one table that both clocks drive.
 * Cloudflare fires `scheduled()` in `src/index.ts` from the cron triggers
 * Terraform declares (`cron_triggers` in
 * `terraform/environments/production/workers-control-plane.tf`), which must
 * list exactly the expressions below; a unit test checks the two agree. The
 * Node host will drive the same table from an in-process loop over
 * `nextCronOccurrence` from `@open-inspect/shared` (H-5); nothing on Node
 * consumes it yet.
 *
 * A slot may fire twice (a retried trigger, two hosts during a cutover) and
 * that is harmless: the automation scheduler's tick claims its work with an
 * SQL compare-and-swap, and the sweeps are idempotent, so a double tick costs
 * extra reads and nothing else. The Node host is planned as one process, so
 * it needs no leader election.
 */

import { checkAutofixQueueHealth } from "./autofix/queue-health";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import { IMAGE_BUILD_SCHEDULER_CRON, runImageBuildScheduler } from "./image-builds/scheduler";
import type { CorrelationContext, Logger } from "./logger";
import type { BackgroundTasks } from "./platform-ports";
import { Scheduler } from "./scheduler/scheduler";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import type { SessionRuntimeClient } from "./session/runtime-client";
import type { Env } from "./types";

/** Every minute: the automation scheduler's tick and the autofix queue health check. */
export const SCHEDULER_TICK_CRON = "* * * * *";

/** What one run of a scheduled job is given. The host builds it per run. */
export interface ScheduledJobDeps {
  env: Env;
  db: SqlDatabase;
  sessions: SessionRuntimeClient;
  backgroundTasks: BackgroundTasks;
  log: Logger;
  /** Identifies this run in logs; the host mints one per run. */
  correlation: CorrelationContext;
}

export interface ScheduledJob {
  readonly name: string;
  /** Five-field cron expression, evaluated in UTC. */
  readonly cron: string;
  /** Run the job once for the slot at `nowMs` (epoch milliseconds). */
  run(deps: ScheduledJobDeps, nowMs: number): Promise<void>;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: "scheduler_tick",
    cron: SCHEDULER_TICK_CRON,
    async run({ env, db, backgroundTasks, log }) {
      backgroundTasks.submit(() => checkAutofixQueueHealth(env, log), {
        name: "autofix_queue_health",
      });
      // The tick runs both the recovery sweep (orphaned/timed-out runs) and
      // processes overdue automations.
      await new Scheduler(db, env, backgroundTasks).tick();
    },
  },
  {
    name: "image_build_scheduler",
    cron: IMAGE_BUILD_SCHEDULER_CRON,
    async run({ env, db, correlation }) {
      await runImageBuildScheduler(env, db, correlation);
    },
  },
  {
    name: "abandoned_draft_sweep",
    cron: ABANDONED_DRAFT_SWEEP_CRON,
    async run({ db, sessions, log }, nowMs) {
      await new AbandonedDraftSweep(
        new SessionIndexStore(db),
        new SessionDraftExpiryClient(sessions),
        log
      ).run(nowMs);
    },
  },
];

/** The job bound to `cron`, or `undefined` when no job runs on that expression. */
export function findScheduledJob(cron: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((job) => job.cron === cron);
}
