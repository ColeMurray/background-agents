import { AuthorizationService } from "../authorization/service";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import type { AutomationRow, AutomationRunRow, AutomationStore } from "../db/automation-store";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { SqlDatabase } from "../db/sql-database";
import type { CorrelationContext, Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";
import {
  enqueueSessionPrompt,
  type SchedulerPromptRequest,
  type SessionPromptOutcome,
} from "./session-prompt";

/**
 * How long after a run's first trigger that slack thread replies, and webhook
 * deliveries with the same sessionKey, keep continuing the same session (matches the
 * interactive thread→session KV TTL of 7 days). Steering does not create new runs, so
 * this is measured from the root run's `created_at` and does not slide — a follow-up
 * after the window forks a fresh run.
 */
const SESSION_CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  | { kind: "fall_through" };

export interface SessionContinuityDeps {
  store: AutomationStore;
  env: Env;
  log: Logger;
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

export async function continueSession(
  deps: SessionContinuityDeps,
  automation: AutomationRow,
  concurrencyKey: string | null,
  now: number,
  policy: ContinuationPolicy
): Promise<ContinuationOutcome> {
  const run = await deps.store.getLatestSteerableRunForConcurrencyKey(
    automation.id,
    concurrencyKey,
    now - SESSION_CONTINUITY_WINDOW_MS
  );
  if (!run?.session_id) return { kind: "fall_through" };

  const fields = { automation_id: automation.id, session_id: run.session_id, ...policy.logFields };
  const actor = await admittedActor(deps, run.session_id, policy, fields);
  if (!actor) {
    deps.log.warn("Blocked session steering for an actor without session access", {
      event: `scheduler.${policy.source}_steer_unauthorized`,
      ...fields,
    });
    return { kind: "skipped", invocationId: null };
  }

  // Outside the try: a follow-up that cannot be attributed must fail, not fall through to a new run.
  const { body, ctx } = await policy.buildPrompt(run, actor);
  let outcome: SessionPromptOutcome;
  try {
    outcome = await enqueueSessionPrompt(deps.env, run.session_id, body, ctx);
  } catch (error) {
    deps.log.warn("Failed to steer session; falling through to trigger path", {
      event: `scheduler.${policy.source}_steer_failed`,
      ...fields,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { kind: "fall_through" };
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
      deps.log.warn("Session refused the follow-up; falling through to trigger path", {
        event: `scheduler.${policy.source}_steer_failed`,
        ...fields,
        status: outcome.status,
        code: outcome.code,
      });
      return { kind: "fall_through" };
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
    if (!actor) return null;
    const admission = await evaluateSessionAdmission(
      actor.context,
      deps.env,
      sessionId,
      "collaborate",
      null
    );
    return admission.kind === "allowed" ? actor : null;
  } catch (error) {
    deps.log.warn("Failed to authorize the actor for session steering", {
      event: `scheduler.${policy.source}_steer_authorization_failed`,
      ...fields,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
}
