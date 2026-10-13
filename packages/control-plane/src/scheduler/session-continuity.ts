import { generateId } from "../auth/crypto";
import { AuthorizationService } from "../authorization/service";
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
import type { CorrelationContext, Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";
import {
  enqueueSerializedSessionPrompt,
  enqueueSessionPrompt,
  type SchedulerPromptRequest,
  type SessionPromptOutcome,
} from "./session-prompt";

/**
 * How long after a session's last activity that slack thread replies, and webhook
 * deliveries with the same sessionKey, keep continuing it (matches the interactive
 * thread→session KV TTL of 7 days, which every interactive follow-up refreshes). A
 * follow-up after the window forks a fresh run.
 */
const SESSION_CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a held follow-up may wait before the sweep treats its release as missed. A
 * launch releases its held follow-ups as soon as its own first prompt is queued.
 */
const HELD_PROMPT_RELEASE_GRACE_MS = 2 * 60 * 1000;
const HELD_PROMPT_SWEEP_LIMIT = 50;

export interface SteeringActor {
  userId: string;
  authorId: string;
  context: RequestContext;
}

export interface ContinuationPolicy {
  source: "slack" | "webhook";
  logFields?: Record<string, unknown>;
  resolveActor(): Promise<SteeringActor | null>;
  buildPrompt(
    run: AutomationRunRow,
    actor: SteeringActor
  ): Promise<{ body: SchedulerPromptRequest; ctx: CorrelationContext }>;
}

export type ContinuationOutcome =
  | { kind: "steered"; invocationId: string }
  | { kind: "skipped"; invocationId: string | null }
  /** The session did not take the follow-up; `status` is null when it could not be reached. */
  | { kind: "refused"; invocationId: string; status: number | null; code: string | null }
  | { kind: "fall_through" };

export interface SessionContinuityDeps {
  store: AutomationStore;
  env: Env;
  log: Logger;
  db: SqlDatabase;
  backgroundJobs: BackgroundTasks;
}

export async function steeringActor(
  db: SqlDatabase,
  backgroundJobs: BackgroundTasks,
  user: { userId: string; authorId: string },
  traceId: string,
  requestId: string
): Promise<SteeringActor | null> {
  const authorization = await new AuthorizationService(db).getEffectiveAuthorization(user.userId);
  if (
    authorization.suspendedAt !== null ||
    !authorization.permissions.includes("sessions.collaborate")
  )
    return null;
  return {
    ...user,
    context: {
      db,
      trace_id: traceId,
      request_id: requestId,
      metrics: createRequestMetrics(),
      executionCtx: backgroundJobs,
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
export async function continueSession(
  deps: SessionContinuityDeps,
  automation: AutomationRow,
  concurrencyKey: string | null,
  now: number,
  policy: ContinuationPolicy
): Promise<ContinuationOutcome> {
  const run = await deps.store.getLatestContinuableRun(automation.id, concurrencyKey);
  if (!run || run.last_activity_at < now - SESSION_CONTINUITY_WINDOW_MS) {
    return { kind: "fall_through" };
  }
  if (!isLaunching(run)) return continueRunSession(deps, run, policy);

  const held = await holdFollowUp(deps, run, policy);
  if (held) return held;
  // The run got past its first prompt while this follow-up was being built.
  const launched = await deps.store.getLatestContinuableRun(automation.id, concurrencyKey);
  return launched && !isLaunching(launched)
    ? continueRunSession(deps, launched, policy)
    : { kind: "fall_through" };
}

/**
 * Queue a launched run's held follow-ups on its session, oldest first. A follow-up that
 * cannot be delivered right now stays held for the sweep, and so do the ones after it,
 * to keep their order.
 */
export async function releaseHeldPrompts(
  deps: SessionContinuityDeps,
  run: AutomationRunRow
): Promise<void> {
  const sessionId = run.session_id;
  if (!sessionId) return;
  for (const held of await deps.store.getHeldPrompts(run.id)) {
    if (!(await releaseHeldPrompt(deps, run, sessionId, held))) return;
  }
}

/**
 * Settle held follow-ups whose release was missed (the launching worker died, or the
 * release failed): release them once their run's first prompt is known to be queued,
 * and drop them once the run ended without it.
 */
export async function sweepHeldPrompts(deps: SessionContinuityDeps, now: number): Promise<void> {
  let runs: AutomationRunRow[];
  try {
    runs = await deps.store.getRunsWithStaleHeldPrompts(
      now - HELD_PROMPT_RELEASE_GRACE_MS,
      HELD_PROMPT_SWEEP_LIMIT
    );
  } catch (error) {
    deps.log.error("Held follow-up sweep failed to query runs", {
      event: "scheduler.recovery.held_prompts_query_error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return;
  }

  for (const run of runs) {
    try {
      if (run.session_id && run.status !== "starting" && run.first_prompt_pending === 0) {
        await releaseHeldPrompts(deps, run);
      } else if (run.status !== "starting" && run.status !== "running") {
        const dropped = await deps.store.deleteHeldPromptsForRun(run.id);
        deps.log.warn("Dropped follow-ups held for a run that ended before its first prompt", {
          event: "scheduler.recovery.held_prompts_dropped",
          automation_id: run.automation_id,
          run_id: run.id,
          run_status: run.status,
          count: dropped,
        });
      }
    } catch (error) {
      deps.log.error("Held follow-up sweep failed to settle a run", {
        event: "scheduler.recovery.held_prompts_error",
        automation_id: run.automation_id,
        run_id: run.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

/** From the run's creation until its own first prompt is on its session's queue. */
function isLaunching(run: AutomationRunRow): boolean {
  return run.status === "starting" || (run.status === "running" && run.first_prompt_pending === 1);
}

async function continueRunSession(
  deps: SessionContinuityDeps,
  run: ContinuableRunRow,
  policy: ContinuationPolicy
): Promise<ContinuationOutcome> {
  const sessionId = run.session_id;
  if (!sessionId) return { kind: "fall_through" };

  const fields = { automation_id: run.automation_id, session_id: sessionId, ...policy.logFields };
  const actor = await admittedActor(deps, sessionId, policy, fields);
  if (!actor) return blocked(deps, policy, fields);

  // Outside the try: a follow-up that cannot be attributed must fail, not fall through to a new run.
  const { body, ctx } = await policy.buildPrompt(run, actor);
  let outcome: SessionPromptOutcome;
  try {
    outcome = await enqueueSessionPrompt(deps.env, sessionId, body, ctx);
  } catch (error) {
    deps.log.warn("Failed to reach the session for a follow-up", {
      event: `scheduler.${policy.source}_steer_failed`,
      ...fields,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { kind: "refused", invocationId: run.invocation_id, status: null, code: null };
  }

  switch (outcome.kind) {
    case "queued":
      deps.log.info("Steered session with a follow-up", {
        event: `scheduler.${policy.source}_steer`,
        ...fields,
      });
      return { kind: "steered", invocationId: run.invocation_id };
    case "duplicate":
      return { kind: "skipped", invocationId: run.invocation_id };
    case "rejected":
      deps.log.warn("Session refused the follow-up", {
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
 * null when the run finished launching first.
 */
async function holdFollowUp(
  deps: SessionContinuityDeps,
  run: ContinuableRunRow,
  policy: ContinuationPolicy
): Promise<ContinuationOutcome | null> {
  const fields = { automation_id: run.automation_id, run_id: run.id, ...policy.logFields };
  let actor: SteeringActor | null;
  try {
    actor = await policy.resolveActor();
  } catch (error) {
    logAuthorizationFailure(deps, policy, fields, error);
    actor = null;
  }
  if (!actor) return blocked(deps, policy, fields);

  const { body, ctx } = await policy.buildPrompt(run, actor);
  const id = generateId();
  const held = await deps.store.holdPromptForLaunchingRun({
    id,
    run_id: run.id,
    actor_user_id: actor.userId,
    actor_author_id: actor.authorId,
    // The sweep may re-send a released prompt after a crash; a request id dedupes it.
    prompt: JSON.stringify({ ...body, clientRequestId: body.clientRequestId ?? `held:${id}` }),
    request_id: ctx.request_id,
    created_at: Date.now(),
  });
  if (!held) return null;

  deps.log.info("Held a follow-up until its run's first prompt is queued", {
    event: `scheduler.${policy.source}_steer_held`,
    ...fields,
  });
  return { kind: "steered", invocationId: run.invocation_id };
}

/** Returns false when the prompt must stay held: it, and the ones after it, are retried. */
async function releaseHeldPrompt(
  deps: SessionContinuityDeps,
  run: AutomationRunRow,
  sessionId: string,
  held: HeldPromptRow
): Promise<boolean> {
  const fields = { automation_id: run.automation_id, session_id: sessionId, held_id: held.id };
  const ctx = { trace_id: `automation:${run.automation_id}`, request_id: held.request_id };
  try {
    const actor = await steeringActor(
      deps.db,
      deps.backgroundJobs,
      { userId: held.actor_user_id, authorId: held.actor_author_id },
      ctx.trace_id,
      ctx.request_id
    );
    if (!actor || !(await mayCollaborate(deps.env, actor, sessionId))) {
      deps.log.warn("Dropped a held follow-up whose actor may not collaborate on the session", {
        event: "scheduler.held_prompt_unauthorized",
        ...fields,
      });
    } else {
      const outcome = await enqueueSerializedSessionPrompt(deps.env, sessionId, held.prompt, ctx);
      if (outcome.kind === "rejected" && outcome.status >= 500) {
        deps.log.warn("Session failed to take a held follow-up; the sweep retries it", {
          event: "scheduler.held_prompt_release_failed",
          ...fields,
          status: outcome.status,
        });
        return false;
      }
      if (outcome.kind === "rejected") {
        deps.log.warn("Dropped a held follow-up the session refused", {
          event: "scheduler.held_prompt_refused",
          ...fields,
          status: outcome.status,
          code: outcome.code,
        });
      }
    }
    await deps.store.deleteHeldPrompt(held.id);
    return true;
  } catch (error) {
    deps.log.warn("Failed to release a held follow-up; the sweep retries it", {
      event: "scheduler.held_prompt_release_failed",
      ...fields,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return false;
  }
}

async function admittedActor(
  deps: SessionContinuityDeps,
  sessionId: string,
  policy: ContinuationPolicy,
  fields: Record<string, unknown>
): Promise<SteeringActor | null> {
  try {
    const actor = await policy.resolveActor();
    return actor && (await mayCollaborate(deps.env, actor, sessionId)) ? actor : null;
  } catch (error) {
    logAuthorizationFailure(deps, policy, fields, error);
    return null;
  }
}

async function mayCollaborate(env: Env, actor: SteeringActor, sessionId: string): Promise<boolean> {
  const admission = await evaluateSessionAdmission(
    actor.context,
    env,
    sessionId,
    "collaborate",
    null
  );
  return admission.kind === "allowed";
}

function blocked(
  deps: SessionContinuityDeps,
  policy: ContinuationPolicy,
  fields: Record<string, unknown>
): ContinuationOutcome {
  deps.log.warn("Blocked session steering for an actor without session access", {
    event: `scheduler.${policy.source}_steer_unauthorized`,
    ...fields,
  });
  return { kind: "skipped", invocationId: null };
}

function logAuthorizationFailure(
  deps: SessionContinuityDeps,
  policy: ContinuationPolicy,
  fields: Record<string, unknown>,
  error: unknown
): void {
  deps.log.warn("Failed to authorize the actor for session steering", {
    event: `scheduler.${policy.source}_steer_authorization_failed`,
    ...fields,
    error: error instanceof Error ? error : new Error(String(error)),
  });
}
