/**
 * Request-driven automation scheduler backed entirely by D1.
 *
 * Invoked by the Worker's `scheduled()` handler, automation routes, and
 * SessionDO completion callbacks. Handles:
 * - Tick: recovery sweep + process overdue automations
 * - Event: delegate source-specific admission and session continuity
 * - Trigger: manual single-automation trigger
 * - RunComplete: callback from SessionDO on execution completion
 */

import type { AutomationEvent } from "@open-inspect/shared/triggers";
import { nextCronOccurrence } from "@open-inspect/shared/cron";
import type { SessionContinuityService } from "./session-continuity-service";
import type * as Crypto from "../auth/crypto";
import { allRunsUnauthorized, toAutomationRun, type AutomationStore } from "../db/automation-store";
import type { Logger } from "../logger";
import type { GitHubEnrichment } from "../session/identity";
import {
  AutomationExecutionUnauthorizedError,
  AutomationTriggerBlockedError,
  type AutomationRunCompletion,
  type SchedulerTickResult,
  type SchedulerTriggerResult,
  type SchedulerEventResult,
} from "./contracts";
import type { AutomationSlackService } from "./slack-service";
import type { AutomationInvocationService } from "./invocation-service";
import type { AutomationFailureService } from "./failure-service";
import type { AutomationRecoveryService } from "./recovery-service";
import type { AutomationEventHandler } from "./event-handler";
import { TICK_CHILD_LAUNCH_BUDGET } from "./launch-policy";

export interface SchedulerDeps {
  store: Pick<
    AutomationStore,
    | "getOverdueAutomations"
    | "getRepositoriesForAutomationIds"
    | "getEnvironmentsForAutomationIds"
    | "recordAuthorizationDenied"
    | "getById"
    | "getRunById"
    | "markRunFirstPromptQueued"
    | "updateRun"
    | "completeTimedOutRun"
  >;
  slack: Pick<AutomationSlackService, "notifyCompletion">;
  invocations: Pick<AutomationInvocationService, "start" | "retryDue">;
  failures: Pick<AutomationFailureService, "applyInvocationOutcome">;
  recovery: Pick<AutomationRecoveryService, "recoverRuns">;
  events: Pick<AutomationEventHandler, "handle">;
  continuity: Pick<SessionContinuityService, "sweepHeldPrompts">;
  clock: Pick<DateConstructor, "now">;
  crypto: Pick<typeof Crypto, "generateId">;
  log: Logger;
}

/** Max automations to process per tick (backpressure). */
const MAX_PER_TICK = 25;

/** Coordinates authorized automation scheduling, dispatch, and completion handling. */
export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  // ─── Tick handler ────────────────────────────────────────────────────────

  async tick(): Promise<SchedulerTickResult> {
    const store = this.deps.store;
    const now = this.deps.clock.now();
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let launchedChildren = 0;

    // 1. Recovery sweeps, then retries whose wait is over
    await this.deps.recovery.recoverRuns();
    await this.deps.continuity.sweepHeldPrompts(now);
    launchedChildren += await this.deps.invocations.retryDue(now);

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
      // push the tick past the budget. Checking before invocation admission
      // prevents the overshoot where a firing materializes and launches up to
      // 10 children before the budget is reconciled. Always admit the first
      // automation so a tick makes progress.
      const estimatedChildren = Math.max(repositories.length + environments.length, 1);
      if (launchedChildren > 0 && launchedChildren + estimatedChildren > TICK_CHILD_LAUNCH_BUDGET) {
        this.deps.log.info("Tick child budget reached; remaining overdue deferred to next tick", {
          event: "scheduler.tick_budget_exhausted",
          launched_children: launchedChildren,
          deferred: overdue.length - index,
        });
        break;
      }
      try {
        const nextRunAt =
          automation.schedule_once_at != null
            ? null
            : nextCronOccurrence(automation.schedule_cron!, automation.schedule_tz).getTime();

        const result = await this.deps.invocations.start({
          automation,
          source: "schedule",
          actorKind: "system",
          scheduledAt: automation.next_run_at!,
          advanceToNextRunAt: nextRunAt,
          repositories,
          environments,
        });

        switch (result.outcome) {
          case "started":
            // Summary parity with the pre-invocations tick: a firing that
            // launched nothing (every child pre-failed or failed to launch)
            // reports as failed, not processed — unless a run waits to retry.
            if (result.launched > 0 || result.runs.some((run) => run.status === "retrying")) {
              processed++;
            } else if (allRunsUnauthorized(result.runs)) {
              skipped++;
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
          case "unauthorized": {
            const deniedAt = this.deps.clock.now();
            await store.recordAuthorizationDenied(
              {
                id: this.deps.crypto.generateId(),
                automation_id: automation.id,
                source: "schedule",
                actor_kind: "system",
                scheduled_at: automation.next_run_at,
                trigger_key: null,
                concurrency_key: null,
                trigger_metadata: null,
                skip_reason: result.reason ?? "execution_authorization_denied",
                failure_counted_at: null,
                created_at: deniedAt,
                updated_at: deniedAt,
              },
              automation.next_run_at!
            );
            this.deps.log.warn("Paused scheduled automation after execution authorization denial", {
              event: "scheduler.authorization_denied",
              automation_id: automation.id,
              scheduled_at: automation.next_run_at,
              reason_code: result.reason ?? "execution_authorization_denied",
            });
            skipped++;
            break;
          }
        }
      } catch (e) {
        this.deps.log.error("Unexpected error processing automation", {
          event: "scheduler.tick_error",
          automation_id: automation.id,
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }

    this.deps.log.info("Tick completed", {
      event: "scheduler.tick_complete",
      processed,
      skipped,
      failed,
      overdue_count: overdue.length,
    });

    return { processed, skipped, failed };
  }

  /** Match an inbound event to authorized automations and start or steer their invocations. */
  async event(event: AutomationEvent): Promise<SchedulerEventResult> {
    return this.deps.events.handle(event);
  }

  // ─── Manual trigger ──────────────────────────────────────────────────────

  /** Manually trigger an automation under the requesting user's authority. */
  async trigger(
    automationId: string,
    requesterUserId: string,
    requesterEnrichment: GitHubEnrichment | null = null
  ): Promise<SchedulerTriggerResult> {
    const store = this.deps.store;
    const automation = await store.getById(automationId);
    if (!automation) {
      throw new Error("Automation not found");
    }

    const result = await this.deps.invocations.start({
      automation,
      source: "manual",
      // Only a signed-in user reaches the trigger route today. A credential that
      // lets an agent trigger runs must record its firings as something else.
      actorKind: "person",
      executionPrincipal: {
        platformUserId: requesterUserId,
        participantUserId: requesterUserId,
        scmEnrichment: requesterEnrichment,
      },
    });

    if (result.outcome === "unauthorized") {
      throw new AutomationExecutionUnauthorizedError(result.reason);
    }
    if (result.outcome === "blocked") throw new AutomationTriggerBlockedError(result.reason);
    if (result.outcome !== "started") {
      // Manual overlap (pre-check or lost race) records nothing.
      throw new AutomationTriggerBlockedError();
    }

    if (allRunsUnauthorized(result.runs)) {
      throw new AutomationExecutionUnauthorizedError(result.runs[0].failure_reason ?? undefined);
    }

    const runs = result.runs.map((run) =>
      toAutomationRun({ ...run, session_title: null, artifact_summary: null })
    );
    if (result.launched === 0) {
      this.deps.log.error("Manual trigger failed", {
        event: "scheduler.manual_trigger_failed",
        automation_id: automationId,
        invocation_id: result.invocationId,
        error: result.runs.find((run) => run.status === "failed")?.failure_reason ?? "unknown",
      });

      throw new Error("Failed to trigger automation");
    }

    this.deps.log.info("Manual trigger succeeded", {
      event: "scheduler.manual_trigger",
      automation_id: automationId,
      invocation_id: result.invocationId,
      launched: result.launched,
    });

    return { invocationId: result.invocationId, runs };
  }

  // ─── Run complete callback ───────────────────────────────────────────────

  async runComplete(body: AutomationRunCompletion): Promise<void> {
    const store = this.deps.store;

    const run = await store.getRunById(body.automationId, body.runId);
    if (!run) {
      this.deps.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: "not_found",
      });
      return;
    }

    // The session ran the run's first prompt, so it was queued even if the
    // launching worker died before recording that. The held-prompt sweep then
    // releases follow-ups held during the launch instead of dropping them.
    await store.markRunFirstPromptQueued(body.runId);

    // SQL-guarded transition: only an active run may go terminal. When the
    // guard suppresses the write (recovery sweep or a concurrent callback got
    // there first) the callback is acknowledged as ignored — a terminal child
    // must never transition again.
    const now = this.deps.clock.now();
    const transitioned = await store.updateRun(
      body.runId,
      body.success
        ? { status: "completed", completed_at: now }
        : {
            status: "failed",
            failure_reason: body.error || "Unknown error",
            completed_at: now,
          }
    );

    // One exception: the sweep's execution timeout is inferred from silence,
    // not observed, so a success that arrives after it is the better record
    // for the run. The correction stops at the run row. The strike the sweep
    // took stays: invocation accounting is unordered, so releasing it here
    // could erase a newer invocation's genuine strike, or race the sweep's own
    // accounting pass into counting a run that is no longer failed. The next
    // fully successful firing resets the streak as it always has.
    const corrected =
      !transitioned && body.success && (await store.completeTimedOutRun(body.runId, now));

    if (corrected) {
      this.deps.log.warn("Run completed after the sweep declared it lost", {
        event: "scheduler.run_complete_corrected",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
        execution_deadline_at: run.execution_deadline_at,
      });
    } else if (!transitioned) {
      this.deps.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: run.status,
      });
      return;
    }

    // Invocation-level accounting: one CAS-guarded strike per invocation on
    // first failure; streak reset once every sibling completed. Skipped for a
    // correction, per above. The slack fan-out below is not: the sweep posts
    // nothing when it declares a run lost, so returning early here would leave
    // the triggering thread with an `eyes` reaction and no result forever.
    if (!corrected) {
      await this.deps.failures.applyInvocationOutcome(body.automationId, run.invocation_id);
    }

    if (body.success) {
      this.deps.log.info("Run completed successfully", {
        event: "scheduler.run_complete",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
      });
    } else {
      this.deps.log.warn("Run completed with failure", {
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
    // coordinates live on the invocation. Only the terminal CAS winner owns
    // publication retries; retrying runComplete itself would be ignored.
    await this.deps.slack.notifyCompletion(run, body);
  }
}
