import type * as Crypto from "../auth/crypto";
import type { AuthorizationService } from "../authorization/service";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import type {
  AutomationRow,
  AutomationRunRow,
  AutomationStore,
  ContinuableRunRow,
  HeldPromptRow,
} from "../db/automation-store";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";
import {
  enqueueSerializedSessionPrompt,
  enqueueSessionPrompt,
  firstPromptRequestId,
  isSessionPromptRequestQueued,
  type SessionPromptOutcome,
} from "./session-prompt";
import type { ContinuationPolicy, ContinuationOutcome, SteeringActor } from "./session-continuity";

/**
 * How long after a session's last activity that slack thread replies, and webhook
 * deliveries with the same sessionKey, keep continuing it (matches the interactive
 * thread→session KV TTL of 7 days, which every interactive follow-up refreshes). A
 * follow-up after the window forks a fresh run.
 */
const SESSION_CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long held follow-ups wait before the sweep tries to settle them, and again after
 * each attempt that could not. A launch releases them as soon as its first prompt is
 * queued, so the sweep only handles a missed or failed release.
 */
const HELD_PROMPT_RETRY_MS = 2 * 60 * 1000;
const HELD_PROMPT_SWEEP_LIMIT = 50;

export interface SessionContinuityServiceDeps {
  store: Pick<
    AutomationStore,
    | "deferHeldPrompts"
    | "deleteHeldPrompt"
    | "deleteHeldPromptsForRun"
    | "getHeldPrompts"
    | "getLatestContinuableRun"
    | "getRunsWithDueHeldPrompts"
    | "getSessionRunsForContinuityKey"
    | "holdPromptForLaunchingRun"
    | "markRunFirstPromptQueued"
  >;
  authorization: Pick<AuthorizationService, "getEffectiveAuthorization">;
  clock: Pick<DateConstructor, "now">;
  crypto: Pick<typeof Crypto, "generateId">;
  env: Env;
  log: Logger;
  db: SqlDatabase;
  backgroundJobs: BackgroundTasks;
}

/** Continue sessions and settle held follow-ups using the scheduler's injected runtime. */
export class SessionContinuityService {
  constructor(private readonly deps: SessionContinuityServiceDeps) {}

  async resolveActor(
    user: { userId: string; authorId: string },
    traceId: string,
    requestId: string
  ): Promise<SteeringActor | null> {
    const authorization = await this.deps.authorization.getEffectiveAuthorization(user.userId);
    if (
      authorization.suspendedAt !== null ||
      !authorization.permissions.includes("sessions.collaborate")
    )
      return null;
    return {
      ...user,
      context: {
        db: this.deps.db,
        trace_id: traceId,
        request_id: requestId,
        metrics: createRequestMetrics(),
        executionCtx: this.deps.backgroundJobs,
        principal: { kind: "user", userId: user.userId },
        authorization,
      } satisfies RequestContext,
    };
  }

  /**
   * Continue the session of the latest run for `concurrencyKey` with a follow-up, if that
   * session was active within the continuity window. A run still launching holds the
   * follow-up until its own first prompt is queued, so the follow-up never lands first.
   */
  async continueSession(
    automation: AutomationRow,
    concurrencyKey: string | null,
    nowMs: number,
    policy: ContinuationPolicy
  ): Promise<ContinuationOutcome> {
    const run = await this.deps.store.getLatestContinuableRun(automation.id, concurrencyKey);
    if (!run || run.last_activity_at < nowMs - SESSION_CONTINUITY_WINDOW_MS)
      return { kind: "fall_through" };
    if (!holdsFollowUps(run)) return this.continueRunSession(run, policy, automation);

    const held = await this.holdFollowUp(run, policy, automation);
    if (held) return held;
    // The run got past its first prompt, and its held follow-ups were released, while
    // this follow-up was being built.
    const launched = await this.deps.store.getLatestContinuableRun(automation.id, concurrencyKey);
    return launched && !holdsFollowUps(launched)
      ? this.continueRunSession(launched, policy, automation)
      : { kind: "fall_through" };
  }

  /**
   * Search every session previously used by a continuity key for a durable prompt receipt.
   * A failed lookup blocks a new delivery only when no other session proves it is a retry.
   */
  async findHistoricalPromptReceipt(
    automation: AutomationRow,
    concurrencyKey: string | null,
    requestId: string
  ): Promise<ContinuationOutcome> {
    const runs = await this.deps.store.getSessionRunsForContinuityKey(
      automation.id,
      concurrencyKey
    );
    let unavailable: (typeof runs)[number] | null = null;
    for (const run of runs) {
      try {
        if (
          await isSessionPromptRequestQueued(this.deps.env, run.session_id, requestId, {
            trace_id: `automation:${automation.id}`,
            request_id: requestId,
          })
        ) {
          return { kind: "skipped", invocationId: run.invocation_id };
        }
      } catch (error) {
        unavailable ??= run;
        this.deps.log.warn("Failed to check a historical session for a follow-up retry", {
          event: "scheduler.webhook_historical_dedup_failed",
          automation_id: automation.id,
          session_id: run.session_id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return unavailable
      ? { kind: "refused", invocationId: unavailable.invocation_id, status: null, code: null }
      : { kind: "fall_through" };
  }

  /**
   * Queue a launched run's held follow-ups on its session, oldest first, until none are
   * left: follow-ups that arrive meanwhile are held behind them. A follow-up that cannot
   * be delivered right now stays held for the sweep, and so do the ones after it, to
   * keep their order. Returns whether every held follow-up was settled.
   */
  async releaseHeldPrompts(run: AutomationRunRow): Promise<boolean> {
    const sessionId = run.session_id;
    if (!sessionId) return false;
    for (
      let held = await this.deps.store.getHeldPrompts(run.id);
      held.length > 0;
      held = await this.deps.store.getHeldPrompts(run.id)
    ) {
      for (const prompt of held) {
        if (!(await this.releaseHeldPrompt(run, sessionId, prompt))) return false;
      }
    }
    return true;
  }

  /**
   * Settle held follow-ups whose release was missed: the launching worker died, or the
   * release or its first-prompt record failed. A run left unsettled is retried later, so
   * the next sweep reaches other runs first.
   */
  async sweepHeldPrompts(nowMs: number): Promise<void> {
    let runs: AutomationRunRow[];
    try {
      runs = await this.deps.store.getRunsWithDueHeldPrompts(nowMs, HELD_PROMPT_SWEEP_LIMIT);
    } catch (error) {
      this.deps.log.error("Held follow-up sweep failed to query runs", {
        event: "scheduler.recovery.held_prompts_query_error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    for (const run of runs) {
      let settled = false;
      try {
        settled = await this.settleHeldPrompts(run);
      } catch (error) {
        this.deps.log.error("Held follow-up sweep failed to settle a run", {
          event: "scheduler.recovery.held_prompts_error",
          automation_id: run.automation_id,
          run_id: run.id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      if (!settled) {
        await this.deps.store
          .deferHeldPrompts(run.id, nowMs + HELD_PROMPT_RETRY_MS)
          .catch((error) =>
            this.deps.log.error("Held follow-up sweep failed to defer a run", {
              event: "scheduler.recovery.held_prompts_error",
              automation_id: run.automation_id,
              run_id: run.id,
              error: error instanceof Error ? error : new Error(String(error)),
            })
          );
      }
    }
  }

  /**
   * Release a run's held follow-ups once its first prompt is queued, and drop them once
   * the run ended without it. Whether the first prompt is queued is the session's answer
   * when the run's own record of it is missing. Returns false to retry later.
   */
  private async settleHeldPrompts(run: AutomationRunRow): Promise<boolean> {
    if (run.status === "starting" || run.first_prompt_pending === 1 || run.session_id === null) {
      const queued =
        run.status !== "starting" &&
        run.session_id !== null &&
        (await isSessionPromptRequestQueued(
          this.deps.env,
          run.session_id,
          firstPromptRequestId(run.id),
          {
            trace_id: `automation:${run.automation_id}`,
            request_id: run.id,
          }
        ));
      if (!queued) {
        if (run.status === "starting" || run.status === "running") return false;
        const dropped = await this.deps.store.deleteHeldPromptsForRun(run.id);
        this.deps.log.warn("Dropped follow-ups held for a run that ended before its first prompt", {
          event: "scheduler.recovery.held_prompts_dropped",
          automation_id: run.automation_id,
          run_id: run.id,
          run_status: run.status,
          count: dropped,
        });
        return true;
      }
      await this.deps.store.markRunFirstPromptQueued(run.id);
    }
    return this.releaseHeldPrompts(run);
  }

  private async continueRunSession(
    run: ContinuableRunRow,
    policy: ContinuationPolicy,
    automation: AutomationRow
  ): Promise<ContinuationOutcome> {
    const sessionId = run.session_id;
    if (!sessionId) return { kind: "fall_through" };

    const fields = { automation_id: run.automation_id, session_id: sessionId, ...policy.logFields };
    const actor = await this.admittedActor(sessionId, policy, fields);
    if (!actor) {
      await policy.releaseDelivery?.();
      return this.blocked(policy, fields);
    }

    // Outside the try: a follow-up that cannot be attributed must fail, not fall through to a new run.
    const { body, ctx } = await policy.buildPrompt(run, actor, automation);
    let outcome: SessionPromptOutcome;
    try {
      outcome = await enqueueSessionPrompt(this.deps.env, sessionId, body, ctx);
    } catch (error) {
      this.deps.log.warn("Failed to reach the session for a follow-up", {
        event: `scheduler.${policy.source}_steer_failed`,
        ...fields,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return { kind: "refused", invocationId: run.invocation_id, status: null, code: null };
    }

    switch (outcome.kind) {
      case "queued":
        await policy.acceptDelivery?.(run);
        this.deps.log.info("Steered session with a follow-up", {
          event: `scheduler.${policy.source}_steer`,
          ...fields,
        });
        return { kind: "steered", invocationId: run.invocation_id };
      // The request ids sent here name a delivery (a webhook's idempotencyKey), so a
      // different prompt under the same id is that delivery again: a retry's context
      // block carries its own receipt time.
      case "duplicate":
      case "request_id_taken":
        await policy.acceptDelivery?.(run);
        return { kind: "skipped", invocationId: run.invocation_id };
      case "rejected":
        await policy.releaseDelivery?.();
        this.deps.log.warn("Session refused the follow-up", {
          event: `scheduler.${policy.source}_steer_failed`,
          ...fields,
          status: outcome.status,
          code: outcome.code,
        });
        return {
          kind: "refused",
          invocationId: run.invocation_id,
          status: outcome.status,
          code: outcome.code,
        };
    }
  }

  /**
   * Hold a follow-up for a launching run. Its session may not exist yet, so session
   * admission waits for the release; the actor's own authority is checked now. Returns
   * null when the run finished launching, and released what it held, first.
   */
  private async holdFollowUp(
    run: ContinuableRunRow,
    policy: ContinuationPolicy,
    automation: AutomationRow
  ): Promise<ContinuationOutcome | null> {
    const fields = { automation_id: run.automation_id, run_id: run.id, ...policy.logFields };
    let actor: SteeringActor | null;
    try {
      actor = await policy.resolveActor();
    } catch (error) {
      this.logAuthorizationFailure(policy, fields, error);
      actor = null;
    }
    if (!actor) {
      await policy.releaseDelivery?.();
      return this.blocked(policy, fields);
    }

    const { body, ctx } = await policy.buildPrompt(run, actor, automation);
    const id = this.deps.crypto.generateId();
    // A retried delivery is held once, and the sweep may re-send a released prompt after
    // a crash, which the session dedupes by this request id.
    const clientRequestId = body.clientRequestId ?? `held:${id}`;
    const held = await this.deps.store.holdPromptForLaunchingRun({
      id,
      run_id: run.id,
      actor_user_id: actor.userId,
      actor_author_id: actor.authorId,
      client_request_id: clientRequestId,
      prompt: JSON.stringify({ ...body, clientRequestId }),
      request_id: ctx.request_id,
      created_at: this.deps.clock.now(),
      retry_at: this.deps.clock.now() + HELD_PROMPT_RETRY_MS,
    });
    if (held === "not_holding") return null;
    await policy.acceptDelivery?.(run);
    if (held === "duplicate") return { kind: "skipped", invocationId: run.invocation_id };

    this.deps.log.info("Held a follow-up until its run's first prompt is queued", {
      event: `scheduler.${policy.source}_steer_held`,
      ...fields,
    });
    return { kind: "steered", invocationId: run.invocation_id };
  }

  /** Returns false when the prompt must stay held: it, and the ones after it, are retried. */
  private async releaseHeldPrompt(
    run: AutomationRunRow,
    sessionId: string,
    held: HeldPromptRow
  ): Promise<boolean> {
    const fields = { automation_id: run.automation_id, session_id: sessionId, held_id: held.id };
    const ctx = { trace_id: `automation:${run.automation_id}`, request_id: held.request_id };
    try {
      const actor = await this.resolveActor(
        { userId: held.actor_user_id, authorId: held.actor_author_id },
        ctx.trace_id,
        ctx.request_id
      );
      if (!actor || !(await this.mayCollaborate(actor, sessionId))) {
        this.deps.log.warn(
          "Dropped a held follow-up whose actor may not collaborate on the session",
          {
            event: "scheduler.held_prompt_unauthorized",
            ...fields,
          }
        );
      } else {
        const outcome = await enqueueSerializedSessionPrompt(
          this.deps.env,
          sessionId,
          held.prompt,
          ctx
        );
        // A full queue or a failing session may take it later; the sender was told it was steered.
        if (outcome.kind === "rejected" && (outcome.status === 429 || outcome.status >= 500)) {
          this.deps.log.warn("Session could not take a held follow-up yet; the sweep retries it", {
            event: "scheduler.held_prompt_release_failed",
            ...fields,
            status: outcome.status,
          });
          return false;
        }
        if (outcome.kind === "rejected") {
          this.deps.log.warn("Dropped a held follow-up the session refused", {
            event: "scheduler.held_prompt_refused",
            ...fields,
            status: outcome.status,
            code: outcome.code,
          });
        }
      }
      await this.deps.store.deleteHeldPrompt(held.id);
      return true;
    } catch (error) {
      this.deps.log.warn("Failed to release a held follow-up; the sweep retries it", {
        event: "scheduler.held_prompt_release_failed",
        ...fields,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  }

  private async admittedActor(
    sessionId: string,
    policy: ContinuationPolicy,
    fields: Record<string, unknown>
  ): Promise<SteeringActor | null> {
    try {
      const actor = await policy.resolveActor();
      return actor && (await this.mayCollaborate(actor, sessionId)) ? actor : null;
    } catch (error) {
      this.logAuthorizationFailure(policy, fields, error);
      return null;
    }
  }

  private async mayCollaborate(actor: SteeringActor, sessionId: string): Promise<boolean> {
    const admission = await evaluateSessionAdmission(
      actor.context,
      this.deps.env,
      sessionId,
      "collaborate",
      null
    );
    return admission.kind === "allowed";
  }

  private blocked(
    policy: ContinuationPolicy,
    fields: Record<string, unknown>
  ): ContinuationOutcome {
    this.deps.log.warn("Blocked session steering for an actor without session access", {
      event: `scheduler.${policy.source}_steer_unauthorized`,
      ...fields,
    });
    return { kind: "skipped", invocationId: null };
  }

  private logAuthorizationFailure(
    policy: ContinuationPolicy,
    fields: Record<string, unknown>,
    error: unknown
  ): void {
    this.deps.log.warn("Failed to authorize the actor for session steering", {
      event: `scheduler.${policy.source}_steer_authorization_failed`,
      ...fields,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * From the run's creation until its own first prompt is on its session's queue, and
 * then until the follow-ups held meanwhile are released, so later ones queue behind them.
 */
function holdsFollowUps(run: ContinuableRunRow): boolean {
  return (
    run.status === "starting" ||
    (run.status === "running" && run.first_prompt_pending === 1) ||
    run.has_held_prompts === 1
  );
}
