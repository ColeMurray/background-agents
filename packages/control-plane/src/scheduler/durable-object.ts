/**
 * SchedulerDO — singleton Durable Object that processes scheduled automations.
 *
 * Woken by the Worker's `scheduled()` handler (cron trigger) or by manual
 * trigger requests from the automation CRUD routes. Handles:
 * - Tick: recovery sweep + process overdue automations
 * - Trigger: manual single-automation trigger
 * - RunComplete: callback from SessionDO on execution completion
 */

import { DurableObject } from "cloudflare:workers";
import {
  automationEventSchema,
  nextCronOccurrence,
  matchesConditions,
  conditionRegistry,
  computeHmacHex,
  type AutomationCallbackContext,
  type AutomationInvocationSource,
  type SlackAutomationEvent,
  type SlackCallbackContext,
  type TriggerConfig,
} from "@open-inspect/shared";
import { z } from "zod";
import {
  AutomationStore,
  toAutomationRun,
  isDuplicateKeyError,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationInvocationRow,
  type InvocationOverlapScope,
  type AutomationRepositoryInsert,
  type AutomationEnvironmentRow,
} from "../db/automation-store";
import { SlackChannelStore } from "../db/slack-channel-store";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  parseSlackTriggerMetadata,
  type SlackRunMetadata,
  type SlackCompletionContext,
} from "./slack-completion";
import { UserStore } from "../db/user-store";
import { createRequestMetrics } from "../db/instrumented-d1";
import { generateId } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { initializeSession } from "../session/initialize";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveAutomationRepositories } from "../automation/repository";
import { resolveAutomationSessionTarget } from "../automation/session-target";
import type { RequestContext } from "../routes/shared";
import { deliverWithRetry } from "../session/callback-delivery";

/** Max automations to process per tick (backpressure). */
const MAX_PER_TICK = 25;

/**
 * Per-tick cap on child-run launches. Each launch costs ~8 subrequests, so an
 * uncapped 25-automation × 10-repo tick would blow the Workers per-invocation
 * subrequest limit; automations left overdue when the budget runs out are
 * simply picked up next tick.
 */
const TICK_CHILD_LAUNCH_BUDGET = 50;

/**
 * Smooths Modal cold-start pressure for multi-repo fan-out. The maximum fan-out
 * is 10 repositories, so this only caps the per-invocation spike.
 */
const AUTOMATION_LAUNCH_CONCURRENCY = 4;

/** Threshold for detecting orphaned "starting" runs (5 minutes). */
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/** Default execution timeout for detecting timed-out runs (90 minutes). */
const DEFAULT_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000;

/** Consecutive failure threshold for auto-pause. */
const AUTO_PAUSE_THRESHOLD = 3;

/** Max runs to recover per sweep type per tick (backpressure). */
const RECOVERY_SWEEP_LIMIT = 50;

/**
 * How far back the finalization sweep scans invocations for missed failure
 * strikes or resets (the crash-after-last-callback window is seconds; a day
 * keeps the derived-status scan cheap while covering long outages).
 */
const INVOCATION_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a slack run's first trigger that thread replies keep continuing
 * the same session (matches the interactive thread→session KV TTL of 7 days). Steering
 * does not create new runs, so this is measured from the root run's `created_at` and
 * does not slide — a reply after the window forks a fresh run.
 */
const SLACK_THREAD_CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Repository label for user-facing surfaces (Slack), read from the run's
 * firing-time snapshot — the automation row's selection may have been edited
 * since this run started.
 */
function formatRunRepositoryLabel(
  run: Pick<AutomationRunRow, "repo_owner" | "repo_name"> | null | undefined
): string {
  return run?.repo_owner && run?.repo_name ? `${run.repo_owner}/${run.repo_name}` : "No repository";
}

const manualTriggerBodySchema = z.object({
  automationId: z.string().min(1),
});

const runCompleteBodySchema = z.object({
  automationId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
});

function badJsonRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

interface StartInvocationParams {
  automation: AutomationRow;
  source: AutomationInvocationSource;
  /** Cron slot being served — becomes scheduled_at and the idempotency key (schedule source only). */
  scheduledAt?: number;
  /** Next cron slot, advanced atomically with the insert (schedule source only). */
  advanceToNextRunAt?: number;
  triggerKey?: string | null;
  concurrencyKey?: string | null;
  /** Source-specific JSON stored on the invocation (slack message coordinates). */
  triggerMetadata?: string | null;
  /** Pre-fetched repository selection (the tick passes its batched fetch). */
  repositories?: AutomationRepositoryInsert[];
  /** Pre-fetched environment selection (the tick passes its batched fetch). */
  environments?: AutomationEnvironmentRow[];
  instructionsOverride?: string;
}

type StartInvocationResult =
  /** Invocation inserted; children launched (some may have pre-failed). */
  | { outcome: "started"; invocationId: string; runs: AutomationRunRow[]; launched: number }
  /** Overlap — a childless skipped invocation was recorded (schedule/event). */
  | { outcome: "skipped" }
  /** Overlap on a manual firing — nothing recorded; the caller answers 409. */
  | { outcome: "blocked" }
  /** Idempotency/dedup collision — another firing owns this slot or event. */
  | { outcome: "deduplicated" };

export class SchedulerDO extends DurableObject<Env> {
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger("scheduler-do", {}, parseLogLevel(env.LOG_LEVEL));
  }

  /**
   * Increment the automation's failure streak and auto-pause at the threshold.
   * Callers gate this per-invocation via the failure_counted_at CAS; only the
   * legacy rollback-window path (runs without an invocation) calls it directly.
   */
  private async trackAutomationFailure(
    store: AutomationStore,
    automationId: string
  ): Promise<void> {
    const count = await store.incrementConsecutiveFailures(automationId);
    if (count >= AUTO_PAUSE_THRESHOLD) {
      await store.autoPause(automationId);
      this.log.warn("Automation auto-paused due to consecutive failures", {
        event: "scheduler.auto_pause",
        automation_id: automationId,
        consecutive_failures: count,
      });
    }
  }

  /**
   * Invocation-level failure/success accounting (D2). Aggregates the sibling
   * runs and applies at most one consecutive-failures strike per invocation
   * (the failure_counted_at CAS admits a single winner across concurrent
   * callbacks, launch failures, and sweeps) or — once every child completed —
   * the streak reset. Idempotent by construction: safe to call after every
   * child transition and again from the finalization sweep.
   */
  private async applyInvocationAccounting(
    store: AutomationStore,
    automationId: string,
    invocationId: string
  ): Promise<void> {
    const aggregate = await store.getInvocationRunAggregate(invocationId);
    if (aggregate.total === 0) return; // childless skip — never counts

    if (aggregate.failed > 0) {
      const won = await store.tryMarkInvocationFailureCounted(invocationId);
      if (!won) return;
      await this.trackAutomationFailure(store, automationId);
    } else if (aggregate.active === 0 && aggregate.completed === aggregate.total) {
      await store.resetConsecutiveFailures(automationId);
    }
  }

  // ─── Invocation creation (all three entry points) ────────────────────────

  /**
   * The single firing pipeline (D6): overlap check per source, atomic
   * invocation+children insert with self-guarded statements, repository
   * resolution with per-repo error capture, child launches, and born-terminal
   * finalization. Tick, manual trigger, and the event path all come through
   * here.
   */
  private async startInvocation(
    store: AutomationStore,
    params: StartInvocationParams
  ): Promise<StartInvocationResult> {
    const { automation, source } = params;
    const now = Date.now();
    const concurrencyKey = params.concurrencyKey ?? null;

    // Schedule/manual firings block on any active run of the automation; event
    // firings block per concurrency key (an automation-wide guard would
    // serialize unrelated events, e.g. PR #42 against PR #43).
    const overlapScope: InvocationOverlapScope =
      source === "event" && concurrencyKey !== null
        ? { kind: "concurrencyKey", concurrencyKey }
        : { kind: "automation" };

    // Cheap pre-check; the guarded insert below re-applies the same predicate
    // atomically, so a race here only costs a wasted child build.
    const activeRun =
      overlapScope.kind === "concurrencyKey"
        ? await store.getActiveRunForKey(automation.id, concurrencyKey)
        : await store.getActiveRunForAutomation(automation.id);
    if (activeRun) {
      return this.recordOverlapSkip(store, params, { advanceSchedule: true });
    }

    const selection =
      params.repositories ?? (await store.getRepositoriesForAutomation(automation.id));
    const environmentSelection =
      params.environments ?? (await store.getEnvironmentsForAutomation(automation.id));
    const resolutions = await resolveAutomationRepositories(this.env, selection);

    const invocationId = generateId();
    const scheduledAt = params.scheduledAt ?? now;

    const childBase = () => ({
      id: generateId(),
      automation_id: automation.id,
      invocation_id: invocationId,
      session_id: null,
      skip_reason: null,
      failure_reason: null,
      scheduled_at: scheduledAt,
      started_at: null,
      completed_at: null,
      created_at: now,
      repo_owner: null,
      repo_name: null,
      repo_id: null,
      base_branch: null,
      environment_id: null,
    });

    // One child per target. Repository children snapshot the resolved repo; a
    // failed resolution pre-fails its child (snapshot from the selection row)
    // without blocking siblings. Environment children snapshot the environment
    // id — the workspace itself resolves at launch time (design §13.3), so a
    // deleted environment fails through the launch-failure path. No targets →
    // one repo-less child.
    const children: AutomationRunRow[] = [
      ...resolutions.map(
        (resolution): AutomationRunRow => ({
          ...childBase(),
          status: resolution.error ? "failed" : "starting",
          failure_reason: resolution.error,
          completed_at: resolution.error ? now : null,
          repo_owner: resolution.repository?.repoOwner ?? resolution.requested.repo_owner,
          repo_name: resolution.repository?.repoName ?? resolution.requested.repo_name,
          repo_id: resolution.repository?.repoId ?? resolution.requested.repo_id,
          base_branch: resolution.repository?.baseBranch ?? resolution.requested.base_branch,
        })
      ),
      ...environmentSelection.map(
        (environment): AutomationRunRow => ({
          ...childBase(),
          status: "starting",
          environment_id: environment.environment_id,
        })
      ),
    ];
    if (children.length === 0) {
      children.push({ ...childBase(), status: "starting" });
    }

    const invocation: AutomationInvocationRow = {
      id: invocationId,
      automation_id: automation.id,
      source,
      scheduled_at: params.scheduledAt ?? null,
      trigger_key: params.triggerKey ?? null,
      concurrency_key: concurrencyKey,
      trigger_metadata: params.triggerMetadata ?? null,
      skip_reason: null,
      failure_counted_at: null,
      created_at: now,
      updated_at: now,
    };

    let inserted: boolean;
    try {
      ({ inserted } = await store.insertInvocationGuarded({
        invocation,
        children,
        overlapScope,
        advanceSchedule:
          source === "schedule" && params.advanceToNextRunAt !== undefined
            ? { nextRunAt: params.advanceToNextRunAt }
            : undefined,
      }));
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        // A UNIQUE violation rolls back the whole batch INCLUDING the schedule
        // advance. The colliding firing owns this slot (cron double-fire) or
        // event (trigger_key dedup) — re-advance and stand down.
        if (source === "schedule" && params.advanceToNextRunAt !== undefined) {
          // Monotonic: never rewind the schedule. A stale duplicate for an old
          // slot must not move next_run_at behind a newer tick's advance.
          await store.advanceNextRunAt(automation.id, params.advanceToNextRunAt);
        }
        return { outcome: "deduplicated" };
      }
      throw e;
    }

    if (!inserted) {
      // Raced an active invocation between the pre-check and the batch. The
      // batch's schedule advance already ran (deliberately unconditional), so
      // the skip record must not advance again.
      return this.recordOverlapSkip(store, params, { advanceSchedule: false });
    }

    const launchChild = async (child: AutomationRunRow): Promise<void> => {
      try {
        const { sessionId } = await this.createSessionForAutomationRun(automation, child);
        await this.sendPromptToSession(
          sessionId,
          automation,
          child.id,
          params.instructionsOverride
        );
        await store.updateRun(child.id, {
          status: "running",
          session_id: sessionId,
          started_at: Date.now(),
        });
        child.status = "running";
        child.session_id = sessionId;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.log.error("Failed to launch automation run", {
          event: "scheduler.session_creation_failed",
          automation_id: automation.id,
          invocation_id: invocationId,
          run_id: child.id,
          error: message,
        });
        try {
          await store.updateRun(child.id, {
            status: "failed",
            failure_reason: message,
            completed_at: Date.now(),
          });
        } catch (updateError) {
          this.log.error("Failed to record launch failure", {
            event: "scheduler.fail_track_error",
            automation_id: automation.id,
            run_id: child.id,
            original_reason: message,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
        child.status = "failed";
        child.failure_reason = message;
      }
    };

    const launchCandidates = children.filter((child) => child.status === "starting");
    let nextLaunchIndex = 0;
    const launchWorkerCount = Math.min(AUTOMATION_LAUNCH_CONCURRENCY, launchCandidates.length);
    await Promise.all(
      Array.from({ length: launchWorkerCount }, async () => {
        for (;;) {
          const child = launchCandidates[nextLaunchIndex++];
          if (!child) return;
          await launchChild(child);
        }
      })
    );
    const launched = launchCandidates.filter((child) => child.status === "running").length;

    // Pre-failed and launch-failed children have no callback coming — apply
    // the failure strike now (CAS-deduped). This is also the born-terminal
    // path: every repo inaccessible → invocation finalizes immediately.
    if (children.some((child) => child.status === "failed")) {
      try {
        await this.applyInvocationAccounting(store, automation.id, invocationId);
      } catch (e) {
        this.log.error("Failed to apply invocation accounting after launch failures", {
          event: "scheduler.fail_track_error",
          automation_id: automation.id,
          invocation_id: invocationId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { outcome: "started", invocationId, runs: children, launched };
  }

  /**
   * Record an overlap-blocked firing. Manual firings surface as a 409 with no
   * row; schedule and event firings persist a childless skipped invocation —
   * for schedule slots atomically with the schedule advance (a skip recorded
   * without its advance would re-collide on the same slot every tick). A skip
   * never stores the event trigger_key: a skip must not consume the dedup
   * slot of a firing that never ran.
   */
  private async recordOverlapSkip(
    store: AutomationStore,
    params: StartInvocationParams,
    options: { advanceSchedule: boolean }
  ): Promise<StartInvocationResult> {
    if (params.source === "manual") return { outcome: "blocked" };

    const now = Date.now();
    await store.insertSkippedInvocation(
      {
        id: generateId(),
        automation_id: params.automation.id,
        source: params.source,
        scheduled_at: params.scheduledAt ?? null,
        trigger_key: null,
        concurrency_key: params.concurrencyKey ?? null,
        trigger_metadata: params.triggerMetadata ?? null,
        skip_reason: "concurrent_run_active",
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      },
      options.advanceSchedule &&
        params.source === "schedule" &&
        params.advanceToNextRunAt !== undefined
        ? { nextRunAt: params.advanceToNextRunAt }
        : undefined
    );
    return { outcome: "skipped" };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/internal/tick") {
      return this.handleTick();
    }
    if (request.method === "POST" && path === "/internal/trigger") {
      return this.handleTrigger(request);
    }
    if (request.method === "POST" && path === "/internal/event") {
      return this.handleEvent(request);
    }
    if (request.method === "POST" && path === "/internal/run-complete") {
      return this.handleRunComplete(request);
    }
    if (request.method === "GET" && path === "/internal/health") {
      return this.handleHealth();
    }

    return new Response("Not Found", { status: 404 });
  }

  // ─── Tick handler ────────────────────────────────────────────────────────

  private async handleTick(): Promise<Response> {
    const store = new AutomationStore(this.env.DB);
    const now = Date.now();
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let launchedChildren = 0;

    // 1. Recovery sweep
    await this.recoverySweep(store);

    // 2. Process overdue automations, bounded by the per-tick child budget.
    const overdue = await store.getOverdueAutomations(now, MAX_PER_TICK);
    const [repositoriesByAutomation, environmentsByAutomation] = await Promise.all([
      store.getRepositoriesForAutomationIds(overdue.map((automation) => automation.id)),
      store.getEnvironmentsForAutomationIds(overdue.map((automation) => automation.id)),
    ]);

    for (const [index, automation] of overdue.entries()) {
      const repositories = repositoriesByAutomation.get(automation.id) ?? [];
      const environments = environmentsByAutomation.get(automation.id) ?? [];
      // Each target — repository or environment — launches one child (a
      // target-less automation launches one null-repo child), so estimate this
      // firing's child count up front and defer whole automations that would
      // push the tick past the budget. Checking before startInvocation
      // prevents the overshoot where a firing materializes and launches up to
      // 10 children before the budget is reconciled. Always admit the first
      // automation so a tick makes progress.
      const estimatedChildren = Math.max(repositories.length + environments.length, 1);
      if (launchedChildren > 0 && launchedChildren + estimatedChildren > TICK_CHILD_LAUNCH_BUDGET) {
        this.log.info("Tick child budget reached; remaining overdue deferred to next tick", {
          event: "scheduler.tick_budget_exhausted",
          launched_children: launchedChildren,
          deferred: overdue.length - index,
        });
        break;
      }
      try {
        const nextRunAt = nextCronOccurrence(
          automation.schedule_cron!,
          automation.schedule_tz
        ).getTime();

        const result = await this.startInvocation(store, {
          automation,
          source: "schedule",
          scheduledAt: automation.next_run_at!,
          advanceToNextRunAt: nextRunAt,
          repositories,
          environments,
        });

        switch (result.outcome) {
          case "started":
            // Summary parity with the pre-invocations tick: a firing that
            // launched nothing (every child pre-failed or failed to launch)
            // reports as failed, not processed.
            if (result.launched > 0) {
              processed++;
            } else {
              failed++;
            }
            launchedChildren += result.runs.length;
            break;
          case "skipped":
          case "deduplicated":
          case "blocked":
            skipped++;
            break;
        }
      } catch (e) {
        this.log.error("Unexpected error processing automation", {
          event: "scheduler.tick_error",
          automation_id: automation.id,
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }

    this.log.info("Tick completed", {
      event: "scheduler.tick_complete",
      processed,
      skipped,
      failed,
      overdue_count: overdue.length,
    });

    return new Response(JSON.stringify({ processed, skipped, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Recovery sweep ──────────────────────────────────────────────────────

  private async recoverySweep(store: AutomationStore): Promise<void> {
    const executionTimeoutMs = parseInt(
      this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS),
      10
    );

    const [orphanedResult, timedOutResult] = await Promise.allSettled([
      store.getOrphanedStartingRuns(ORPHAN_THRESHOLD_MS, RECOVERY_SWEEP_LIMIT),
      store.getTimedOutRunningRuns(executionTimeoutMs, RECOVERY_SWEEP_LIMIT),
    ]);

    const orphaned = orphanedResult.status === "fulfilled" ? orphanedResult.value : [];
    const timedOut = timedOutResult.status === "fulfilled" ? timedOutResult.value : [];

    if (orphanedResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query orphaned runs", {
        event: "scheduler.recovery.query_error",
        category: "orphaned",
        error:
          orphanedResult.reason instanceof Error
            ? orphanedResult.reason.message
            : String(orphanedResult.reason),
      });
    }

    if (timedOutResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query timed-out runs", {
        event: "scheduler.recovery.query_error",
        category: "timed_out",
        error:
          timedOutResult.reason instanceof Error
            ? timedOutResult.reason.message
            : String(timedOutResult.reason),
      });
    }

    if (orphaned.length === 0 && timedOut.length === 0) {
      await this.finalizationSweep(store);
      return;
    }

    for (const run of orphaned) {
      this.log.warn("Recovering orphaned starting run", {
        event: "scheduler.recovery.orphaned",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }
    for (const run of timedOut) {
      this.log.warn("Recovering timed-out running run", {
        event: "scheduler.recovery.timed_out",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }

    const now = Date.now();
    const recoveredRuns: AutomationRunRow[] = [];

    if (orphaned.length > 0) {
      try {
        await store.bulkFailRuns(
          orphaned.map((r) => r.id),
          "session_creation_timeout",
          now
        );
        recoveredRuns.push(...orphaned);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark orphaned runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "orphaned",
          count: orphaned.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (timedOut.length > 0) {
      try {
        await store.bulkFailRuns(
          timedOut.map((r) => r.id),
          "execution_timeout",
          now
        );
        recoveredRuns.push(...timedOut);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark timed-out runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "timed_out",
          count: timedOut.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (recoveredRuns.length === 0) {
      await this.finalizationSweep(store);
      return;
    }

    // Failure accounting: strikes are per INVOCATION (CAS-deduped), so two
    // stuck children of one fan-out cost one strike, not two. Runs without an
    // invocation link (rollback-window writes by pre-invocation code) keep the
    // legacy per-run bulk accounting until the backfill repairs them.
    const affectedInvocations = new Map<string, string>(); // invocation id → automation id
    const legacyCounts = new Map<string, number>();
    for (const run of recoveredRuns) {
      if (run.invocation_id) {
        affectedInvocations.set(run.invocation_id, run.automation_id);
      } else {
        legacyCounts.set(run.automation_id, (legacyCounts.get(run.automation_id) ?? 0) + 1);
      }
    }

    for (const [invocationId, automationId] of affectedInvocations) {
      try {
        await this.applyInvocationAccounting(store, automationId, invocationId);
      } catch (e) {
        this.log.error("Recovery sweep failed to track failures", {
          event: "scheduler.recovery.bulk_track_error",
          automation_id: automationId,
          invocation_id: invocationId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (legacyCounts.size > 0) {
      let newCounts: Map<string, number>;
      try {
        newCounts = await store.bulkIncrementFailures(legacyCounts);
      } catch (e) {
        this.log.error("Recovery sweep failed to track failures", {
          event: "scheduler.recovery.bulk_track_error",
          error: e instanceof Error ? e.message : String(e),
        });
        newCounts = new Map();
      }

      for (const [automationId, count] of newCounts) {
        if (count < AUTO_PAUSE_THRESHOLD) continue;

        try {
          await store.autoPause(automationId);
          this.log.warn("Automation auto-paused due to consecutive failures", {
            event: "scheduler.auto_pause",
            automation_id: automationId,
            consecutive_failures: count,
          });
        } catch (e) {
          this.log.error("Recovery sweep failed to auto-pause automation", {
            event: "scheduler.recovery.auto_pause_error",
            automation_id: automationId,
            consecutive_failures: count,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    await this.finalizationSweep(store);
  }

  /**
   * D2c arm: invocation-level accounting missed in the crash window between a
   * child's terminal update and its callback's accounting — all-terminal
   * invocations with an uncounted failure, and failing automations whose
   * latest invocation may be a fully-completed one (missed reset). Every
   * application goes through the same CAS-guarded, idempotent helper, so
   * overlap with live callbacks is harmless.
   */
  private async finalizationSweep(store: AutomationStore): Promise<void> {
    const since = Date.now() - INVOCATION_SWEEP_WINDOW_MS;
    try {
      const uncounted = await store.getUncountedFailedInvocations(since, RECOVERY_SWEEP_LIMIT);
      for (const invocation of uncounted) {
        await this.applyInvocationAccounting(store, invocation.automation_id, invocation.id);
      }

      const resetCandidates = await store.getStaleFailureResetCandidates(
        since,
        RECOVERY_SWEEP_LIMIT
      );
      for (const candidate of resetCandidates) {
        await this.applyInvocationAccounting(
          store,
          candidate.automation_id,
          candidate.invocation_id
        );
      }
    } catch (e) {
      this.log.error("Invocation finalization sweep failed", {
        event: "scheduler.recovery.finalization_error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ─── Event handler ───────────────────────────────────────────────────────

  private async handleEvent(request: Request): Promise<Response> {
    const parsedEvent = automationEventSchema.safeParse(await request.json());
    if (!parsedEvent.success) {
      return badJsonRequest("Invalid automation event");
    }

    const event = parsedEvent.data;
    const store = new AutomationStore(this.env.DB);

    // 1. Find matching automations
    let candidates: AutomationRow[];
    switch (event.source) {
      case "webhook": {
        const automation = await store.getById(event.automationId);
        candidates =
          automation && automation.enabled === 1 && !automation.deleted_at ? [automation] : [];
        break;
      }
      case "sentry": {
        const automation = await store.getById(event.automationId);
        candidates =
          automation &&
          automation.enabled === 1 &&
          !automation.deleted_at &&
          automation.event_type === event.eventType
            ? [automation]
            : [];
        break;
      }
      case "github":
      case "linear":
        candidates = await store.getAutomationsForEvent(
          event.repoOwner,
          event.repoName,
          event.source === "github" ? "github_event" : "linear_event",
          event.eventType
        );
        break;
      case "slack":
        candidates = await new SlackChannelStore(this.env.DB).getSlackAutomationsForChannel(
          event.channelId
        );
        break;
    }

    let triggered = 0;
    let skipped = 0;
    // Follow-ups routed into an already-active thread's session (slack steering).
    let steered = 0;
    // Surface at most one concurrency-skip ephemeral per event, even when
    // several automations watch the same thread and all skip.
    let concurrencySkipped = false;

    for (const automation of candidates) {
      const now = Date.now();

      // Slack thread continuity — mirrors the interactive @mention path: any reply
      // in a thread that already has a session (any run status, within the
      // continuity window) continues that session, regardless of trigger
      // conditions. A reply is a steer, not a new trigger: a natural reply ("also
      // do X") won't contain the keyword that started the run, and a reply after
      // the run finished should still land in the same session. Its reply posts
      // back in-thread via the slack completion callback, exactly like an
      // interactive follow-up.
      if (event.source === "slack") {
        const steerable = await store.getLatestSteerableRunForThread(
          automation.id,
          event.concurrencyKey,
          now - SLACK_THREAD_CONTINUITY_WINDOW_MS
        );
        if (steerable?.session_id && (await this.steerSession(steerable, automation, event))) {
          steered++;
          continue;
        }
        // No steerable session (outside the window, no session yet, or a rare
        // enqueue error) → fall through. Like the @mention path's stale-session
        // recovery, the reply is re-evaluated as a potential new trigger below.
      }

      // Trigger conditions gate starting a NEW run.
      const config: TriggerConfig = automation.trigger_config
        ? JSON.parse(automation.trigger_config)
        : { conditions: [] };
      if (!matchesConditions(config.conditions, event, conditionRegistry)) {
        continue;
      }

      // Event firings are invocations of 1 (or 0 children when skipped): same
      // per-key concurrency, same trigger_key dedup — both now enforced on the
      // invocation, atomically. The overlap skip also covers the brief slack
      // window before a run has created its session (no steerable row yet), so
      // a reply racing the initial trigger gets the "already active" notice
      // instead of a second session.
      const result = await this.startInvocation(store, {
        automation,
        source: "event",
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata: event.source === "slack" ? serializeSlackTriggerMetadata(event) : null,
        instructionsOverride: `${event.contextBlock}\n---\n\n${automation.instructions}`,
      });

      switch (result.outcome) {
        case "started":
          // Counter parity with the pre-invocations path: a firing whose
          // launch failed counted as neither triggered nor skipped.
          if (result.launched > 0) {
            triggered++;
          }
          break;
        case "skipped":
          if (event.source === "slack") {
            concurrencySkipped = true;
          }
          skipped++;
          break;
        case "deduplicated":
        case "blocked":
          skipped++;
          break;
      }
    }

    if (event.source === "slack" && concurrencySkipped) {
      await this.notifySlackConcurrencySkip(event);
    }

    this.log.info("Event processed", {
      event: "scheduler.event_processed",
      source: event.source,
      event_type: event.eventType,
      trigger_key: event.triggerKey,
      triggered,
      skipped,
      steered,
      candidates: candidates.length,
    });

    return new Response(JSON.stringify({ triggered, skipped, steered }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Manual trigger ──────────────────────────────────────────────────────

  private async handleTrigger(request: Request): Promise<Response> {
    const parsedBody = manualTriggerBodySchema.safeParse(await request.json());
    if (!parsedBody.success) return badJsonRequest("automationId required");

    const { automationId } = parsedBody.data;

    const store = new AutomationStore(this.env.DB);
    const automation = await store.getById(automationId);
    if (!automation) {
      return new Response(JSON.stringify({ error: "Automation not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await this.startInvocation(store, { automation, source: "manual" });

    if (result.outcome !== "started") {
      // Manual overlap (pre-check or lost race) records nothing and answers 409.
      return new Response(JSON.stringify({ error: "An active run already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const runs = result.runs.map((run) =>
      toAutomationRun({ ...run, session_title: null, artifact_summary: null })
    );
    const allFailed = runs.every((run) => run.status === "failed");

    if (allFailed) {
      this.log.error("Manual trigger failed", {
        event: "scheduler.manual_trigger_failed",
        automation_id: automationId,
        invocation_id: result.invocationId,
        error: result.runs[0]?.failure_reason ?? "unknown",
      });

      return new Response(JSON.stringify({ error: "Failed to trigger automation" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.log.info("Manual trigger succeeded", {
      event: "scheduler.manual_trigger",
      automation_id: automationId,
      invocation_id: result.invocationId,
      launched: result.launched,
    });

    // `run` (first child) is the deprecated pre-invocations response field;
    // removed with the other one-release compatibility artifacts.
    return new Response(JSON.stringify({ invocationId: result.invocationId, runs }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Run complete callback ───────────────────────────────────────────────

  private async handleRunComplete(request: Request): Promise<Response> {
    const parsedBody = runCompleteBodySchema.safeParse(await request.json());
    if (!parsedBody.success) return badJsonRequest("Invalid run-complete callback");

    const body = parsedBody.data;

    const store = new AutomationStore(this.env.DB);

    const run = await store.getRunById(body.automationId, body.runId);
    if (!run) {
      this.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: "not_found",
      });
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // SQL-guarded transition: only an active run may go terminal. When the
    // guard suppresses the write (recovery sweep or a concurrent callback got
    // there first) the callback is acknowledged as ignored — a terminal child
    // must never transition again.
    const transitioned = await store.updateRun(
      body.runId,
      body.success
        ? { status: "completed", completed_at: Date.now() }
        : {
            status: "failed",
            failure_reason: body.error || "Unknown error",
            completed_at: Date.now(),
          }
    );

    if (!transitioned) {
      this.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: run.status,
      });
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Invocation-level accounting: one CAS-guarded strike per invocation on
    // first failure; streak reset once every sibling completed. Runs without
    // an invocation link (rollback-window writes) keep the legacy per-run
    // accounting until the backfill repairs them.
    if (run.invocation_id) {
      await this.applyInvocationAccounting(store, body.automationId, run.invocation_id);
    } else if (body.success) {
      await store.resetConsecutiveFailures(body.automationId);
    } else {
      await this.trackAutomationFailure(store, body.automationId);
    }

    if (body.success) {
      this.log.info("Run completed successfully", {
        event: "scheduler.run_complete",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
      });
    } else {
      this.log.warn("Run completed with failure", {
        event: "scheduler.run_failed",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
        error: body.error,
      });
    }

    // Slack-triggered runs post the agent's result into the triggering message's
    // thread and clear the `eyes` reaction when they finish. The scheduler owns
    // this fan-out (not the session callback path) because the message
    // coordinates live on the invocation. Best-effort.
    const invocation = run.invocation_id ? await store.getInvocationById(run.invocation_id) : null;
    const slackMeta = parseSlackTriggerMetadata(invocation?.trigger_metadata ?? null);
    if (slackMeta) {
      const automation = await store.getById(body.automationId);
      await this.notifySlackCompletion(run, slackMeta, {
        sessionId: body.sessionId,
        messageId: body.messageId,
        success: body.success,
        error: body.error,
        repoFullName: formatRunRepositoryLabel(run),
        model: automation?.model ?? "",
        reasoningEffort: automation?.reasoning_effort ?? undefined,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Tell the slack-bot to post a slack-triggered run's result into the triggering
   * message's thread and clear the `eyes` reaction, via its
   * `/callbacks/automation-complete` endpoint. Signs the body with
   * `INTERNAL_CALLBACK_SECRET` (in-body HMAC, matching the bot's other callbacks).
   * No-ops when the run has no triggering message, when `SLACK_BOT` is unbound, or
   * when the secret is unset — all best-effort.
   */
  private async notifySlackCompletion(
    run: AutomationRunRow,
    meta: SlackRunMetadata,
    ctx: SlackCompletionContext
  ): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = this.env.INTERNAL_CALLBACK_SECRET;
    if (!binding || !secret) return;

    const body = buildSlackCompletionNotification(meta, ctx);
    if (!body) return;

    const signature = await computeHmacHex(JSON.stringify(body), secret);
    await deliverWithRetry(
      (signal) =>
        binding.fetch("https://internal/callbacks/automation-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, signature }),
          signal,
        }),
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ({ attempt, response, error }) => {
        this.log.warn("Slack completion callback failed", {
          event: "scheduler.slack_complete_failed",
          automation_id: run.automation_id,
          run_id: run.id,
          attempt,
          ...(response ? { http_status: response.status } : {}),
          ...(error !== undefined
            ? { error: error instanceof Error ? error : new Error(String(error)) }
            : {}),
        });
      }
    );
  }

  /**
   * Post a best-effort ephemeral "a run is already active for this thread"
   * notice to the message author when a slack event is dropped by the
   * per-thread concurrency guard. No-ops without a binding/secret/actor.
   */
  private async notifySlackConcurrencySkip(event: SlackAutomationEvent): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = this.env.INTERNAL_CALLBACK_SECRET;
    if (!binding || !secret) return;

    const body = buildSlackSkipNotification({
      channelId: event.channelId,
      actorUserId: event.actorUserId,
      threadTs: event.threadTs,
      ts: event.ts,
    });
    if (!body) return;

    try {
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.log.warn("Slack skip callback failed", {
          event: "scheduler.slack_skip_failed",
          channel: event.channelId,
          http_status: response.status,
        });
      }
    } catch (e) {
      this.log.warn("Slack skip callback errored", {
        event: "scheduler.slack_skip_failed",
        channel: event.channelId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  // ─── Health check ────────────────────────────────────────────────────────

  private async handleHealth(): Promise<Response> {
    const store = new AutomationStore(this.env.DB);
    const overdueCount = await store.countOverdue(Date.now());

    return new Response(
      JSON.stringify({
        status: "healthy",
        overdueCount,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ─── Session creation ────────────────────────────────────────────────────

  private async createSessionForAutomationRun(
    automation: AutomationRow,
    run: AutomationRunRow
  ): Promise<{ sessionId: string }> {
    const sessionId = generateId();

    // Resolve the canonical user_id for the session index.
    // Automations created through the web UI populate user_id at creation time
    // (handleCreateAutomation resolves it for both GitHub and Google users), so this
    // lookup is skipped for them. The fallback below only covers legacy rows with
    // user_id = NULL: those predate Google login and store the GitHub numeric user ID
    // in created_by (from NextAuth session.user.id), so a github-only identity lookup
    // recovers the canonical user. It becomes dead code once legacy rows are backfilled.
    let userId = automation.user_id;
    if (!userId && automation.created_by && automation.created_by !== "anonymous") {
      try {
        const userStore = new UserStore(this.env.DB);
        const identity = await userStore.getIdentity("github", automation.created_by);
        if (identity) {
          userId = identity.userId;
        }
      } catch {
        // Best-effort — proceed without user_id
      }
    }

    const ctx: RequestContext = {
      trace_id: `automation:${automation.id}`,
      request_id: run.id,
      metrics: createRequestMetrics(),
    };

    // What the session opens — the run's repository snapshot or, for
    // environment-bound automations, the environment's workspace. All target
    // semantics live in resolveAutomationSessionTarget; a resolution failure
    // throws into launchChild's failure path.
    const target = await resolveAutomationSessionTarget(this.env, run, ctx, this.log);

    // Session-scoped integration settings resolve from the primary member
    // (design §6.2), with environment-bound runs layering that environment's
    // overrides on top (design §13.5) — same rules as handleCreateSession.
    const scopeMembers =
      target.repositories ??
      (target.repoOwner && target.repoName
        ? [{ repoOwner: target.repoOwner, repoName: target.repoName }]
        : []);
    const { codeServerEnabled, sandboxSettings } = await resolveSessionScopedSettings(
      this.env.DB,
      scopeMembers,
      target.environmentId
    );

    await initializeSession(
      this.env,
      {
        sessionId,
        ...target,
        title: `[Auto] ${automation.name}`,
        model: automation.model,
        reasoningEffort: automation.reasoning_effort,
        participantUserId: automation.created_by,
        platformUserId: userId,
        scmTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        codeServerEnabled,
        sandboxSettings,
        spawnSource: "automation",
        spawnDepth: 0,
        automationId: automation.id,
        automationRunId: run.id,
      },
      ctx
    );

    return { sessionId };
  }

  private async sendPromptToSession(
    sessionId: string,
    automation: AutomationRow,
    runId: string,
    instructionsOverride?: string
  ): Promise<void> {
    const callbackContext: AutomationCallbackContext = {
      source: "automation",
      automationId: automation.id,
      runId,
      automationName: automation.name,
    };

    await this.enqueueSessionPrompt(sessionId, {
      content: instructionsOverride ?? automation.instructions,
      authorId: automation.created_by,
      source: "automation",
      callbackContext,
    });
  }

  /**
   * Route a follow-up slack message in a thread to its run's existing session as
   * the next turn — whether that run is still in flight, completed, or failed —
   * so every reply in the thread continues the same session, like the interactive
   * @mention path. If the session has gone idle the prompt re-spawns/restores it
   * in the background; its reply posts back in-thread via the slack completion
   * callback (source "slack"), exactly like an interactive follow-up. Returns
   * false when the enqueue fails, so the caller can fall through to the trigger
   * path (stale-session recovery).
   */
  private async steerSession(
    run: AutomationRunRow,
    automation: AutomationRow,
    event: SlackAutomationEvent
  ): Promise<boolean> {
    const sessionId = run.session_id!;
    const callbackContext: SlackCallbackContext = {
      source: "slack",
      channel: event.channelId,
      // Post in the existing thread; for a reply, threadTs is the thread root.
      threadTs: event.threadTs ?? event.ts,
      // React on (and later clear) the follow-up message itself.
      reactionMessageTs: event.ts,
      repoFullName: formatRunRepositoryLabel(run),
      model: automation.model,
      reasoningEffort: automation.reasoning_effort ?? undefined,
    };

    try {
      await this.enqueueSessionPrompt(sessionId, {
        content: event.text,
        authorId: `slack:${event.actorUserId}`,
        source: "slack",
        callbackContext,
      });
      this.log.info("Steered thread session with slack follow-up", {
        event: "scheduler.slack_steer",
        automation_id: automation.id,
        session_id: sessionId,
        channel: event.channelId,
      });
      return true;
    } catch (e) {
      this.log.warn("Failed to steer thread session; falling through to trigger path", {
        event: "scheduler.slack_steer_failed",
        automation_id: automation.id,
        session_id: sessionId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
      return false;
    }
  }

  /** Enqueue a prompt onto a session's queue via its DO `/internal/prompt` route. */
  private async enqueueSessionPrompt(
    sessionId: string,
    body: {
      content: string;
      authorId: string;
      source: string;
      callbackContext: AutomationCallbackContext | SlackCallbackContext;
    }
  ): Promise<void> {
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!promptResponse.ok) {
      throw new Error(`Prompt enqueue failed with status ${promptResponse.status}`);
    }
  }
}

/**
 * Serialize a slack event's message coordinates for the invocation's
 * trigger_metadata — carried by both real firings and concurrency skips.
 */
function serializeSlackTriggerMetadata(event: SlackAutomationEvent): string {
  const metadata: SlackRunMetadata = {
    channel: event.channelId,
    messageTs: event.ts,
  };
  return JSON.stringify(metadata);
}
