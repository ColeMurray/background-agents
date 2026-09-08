import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAutofixQueueHealth } from "./autofix/queue-health";
import { SessionIndexStore } from "./db/session-index";
import type { SqlDatabase } from "./db/sql-database";
import type * as ImageBuildScheduler from "./image-builds/scheduler";
import { IMAGE_BUILD_SCHEDULER_CRON, runImageBuildScheduler } from "./image-builds/scheduler";
import type { Logger } from "./logger";
import type { BackgroundTasks } from "./platform-ports";
import { Scheduler } from "./scheduler/scheduler";
import type * as AbandonedDraftSweepModule from "./session/abandoned-draft-sweep";
import {
  ABANDONED_DRAFT_SWEEP_CRON,
  AbandonedDraftSweep,
  SessionDraftExpiryClient,
} from "./session/abandoned-draft-sweep";
import type { SessionRuntimeClient } from "./session/runtime-client";
import {
  SCHEDULED_JOBS,
  SCHEDULER_TICK_CRON,
  findScheduledJob,
  type ScheduledJobDeps,
} from "./scheduled-jobs";
import type { Env } from "./types";

// The job bodies are mocked; the cron constants stay the production values so
// the Terraform parity check below reads what the Worker really registers.
vi.mock("./autofix/queue-health", () => ({ checkAutofixQueueHealth: vi.fn(async () => {}) }));
vi.mock("./image-builds/scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBuildScheduler>()),
  runImageBuildScheduler: vi.fn(async () => ({})),
}));
vi.mock("./scheduler/scheduler", () => ({
  Scheduler: vi.fn(function () {
    return { tick: schedulerTick };
  }),
}));
vi.mock("./session/abandoned-draft-sweep", async (importOriginal) => ({
  ...(await importOriginal<typeof AbandonedDraftSweepModule>()),
  AbandonedDraftSweep: vi.fn(function () {
    return { run: sweepRun };
  }),
  SessionDraftExpiryClient: vi.fn(),
}));

const { schedulerTick, sweepRun } = vi.hoisted(() => ({
  schedulerTick: vi.fn(async () => ({})),
  sweepRun: vi.fn(async () => ({})),
}));

const TERRAFORM_WORKER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../terraform/environments/production/workers-control-plane.tf"
);

/** The `cron_triggers` Terraform declares for the control-plane Worker. */
function terraformCronTriggers(): string[] {
  const match = /cron_triggers\s*=\s*\[([^\]]*)\]/.exec(readFileSync(TERRAFORM_WORKER, "utf8"));
  if (!match) throw new Error(`No cron_triggers in ${TERRAFORM_WORKER}`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function fakeDeps(): ScheduledJobDeps & {
  submitted: Array<{ name: string; task: () => Promise<unknown> }>;
} {
  const submitted: Array<{ name: string; task: () => Promise<unknown> }> = [];
  const backgroundTasks: BackgroundTasks = {
    submit(task, metadata) {
      submitted.push({ name: metadata.name, task });
    },
  };
  return {
    env: { LOG_LEVEL: "error" } as unknown as Env,
    db: {} as SqlDatabase,
    sessions: {} as SessionRuntimeClient,
    backgroundTasks,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    correlation: { trace_id: "trace-1", request_id: "request-1" },
    submitted,
  };
}

describe("SCHEDULED_JOBS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds each cron expression to exactly one job, and Terraform's triggers to exactly those", () => {
    const crons = SCHEDULED_JOBS.map((job) => job.cron);
    expect(new Set(crons).size).toBe(crons.length);
    expect(new Set(SCHEDULED_JOBS.map((job) => job.name)).size).toBe(crons.length);
    expect([...crons].sort()).toEqual(
      [SCHEDULER_TICK_CRON, IMAGE_BUILD_SCHEDULER_CRON, ABANDONED_DRAFT_SWEEP_CRON].sort()
    );
    expect([...terraformCronTriggers()].sort()).toEqual([...crons].sort());
    for (const job of SCHEDULED_JOBS) expect(findScheduledJob(job.cron)).toBe(job);
    expect(findScheduledJob("0 0 * * *")).toBeUndefined();
  });

  it("runs the every-minute tick: queue health in the background, the scheduler tick awaited", async () => {
    const deps = fakeDeps();

    await findScheduledJob(SCHEDULER_TICK_CRON)!.run(deps, 1_000);

    expect(Scheduler).toHaveBeenCalledWith(deps.db, deps.env, deps.backgroundTasks);
    expect(schedulerTick).toHaveBeenCalledTimes(1);
    expect(deps.submitted.map((entry) => entry.name)).toEqual(["autofix_queue_health"]);
    expect(checkAutofixQueueHealth).not.toHaveBeenCalled();
    await deps.submitted[0]!.task();
    expect(checkAutofixQueueHealth).toHaveBeenCalledWith(deps.env, deps.log);
  });

  it("runs the image-build scheduler with the run's correlation", async () => {
    const deps = fakeDeps();

    await findScheduledJob(IMAGE_BUILD_SCHEDULER_CRON)!.run(deps, 1_000);

    expect(runImageBuildScheduler).toHaveBeenCalledWith(deps.env, deps.db, deps.correlation);
    expect(deps.submitted).toEqual([]);
  });

  it("runs the abandoned-draft sweep over the index store and the session client at the run's time", async () => {
    const deps = fakeDeps();

    await findScheduledJob(ABANDONED_DRAFT_SWEEP_CRON)!.run(deps, 1_234_567);

    expect(SessionDraftExpiryClient).toHaveBeenCalledWith(deps.sessions);
    const [index, client, log] = vi.mocked(AbandonedDraftSweep).mock.calls[0]!;
    expect(index).toBeInstanceOf(SessionIndexStore);
    expect(client).toBe(vi.mocked(SessionDraftExpiryClient).mock.instances[0]);
    expect(log).toBe(deps.log);
    expect(sweepRun).toHaveBeenCalledWith(1_234_567);
  });
});
