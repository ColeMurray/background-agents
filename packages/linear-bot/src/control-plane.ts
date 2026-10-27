/**
 * Control-plane calls shared across handlers: actor enrollment and the
 * team-scoped reads used by the repos, environments, and integration-settings
 * modules.
 */

import { z } from "zod";
import {
  ACTOR_EMAIL_REQUIRED_CODE,
  type ActorProfileClaims,
  type EnrollActorResult,
} from "@open-inspect/shared/types/actors";
import type { Env, LinearChannelScope } from "./types";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";

const log = createLogger("control-plane");

/** A non-OK control-plane response, carrying the status for structured logs. */
export class ControlPlaneRequestError extends Error {
  constructor(
    path: string,
    readonly status: number
  ) {
    super(`Control plane GET ${path} failed with ${status}`);
    this.name = "ControlPlaneRequestError";
  }
}

/**
 * GET a control-plane endpoint on behalf of one Linear team and return its JSON
 * body, throwing {@link ControlPlaneRequestError} on a non-OK response.
 */
export async function fetchControlPlaneJson(
  env: Env,
  path: string,
  scope: LinearChannelScope,
  traceId?: string
): Promise<unknown> {
  const url = new URL(`https://internal${path}`);
  url.searchParams.set("channel", `linear:${scope.linearTeamId}`);
  const response = await signedControlPlaneFetch(
    env,
    {
      method: "GET",
      url: url.toString(),
      traceId,
      actor: scope.actorUserId ? `linear:${scope.actorUserId}` : undefined,
    },
    { headers: { Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new ControlPlaneRequestError(path, response.status);
  }
  return response.json();
}

const enrollActorRefusalSchema = z.object({ code: z.string().optional().catch(undefined) });

/**
 * Present a Linear user's profile before any other request that carries them
 * as the actor. The control plane links a new actor to an existing user by
 * email only when it enrolls the actor and never relinks a known one, so a
 * claim-less first request would give the user a second account. Callers stop
 * on any outcome but `enrolled`.
 */
export async function enrollActor(
  env: Env,
  actor: { userId: string; displayName?: string; email?: string },
  traceId?: string
): Promise<EnrollActorResult> {
  const base = { trace_id: traceId, linear_user_id: actor.userId };
  const body: ActorProfileClaims = { displayName: actor.displayName, email: actor.email };
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "POST",
      url: "https://internal/actors/me",
      body: JSON.stringify(body),
      actor: `linear:${actor.userId}`,
      traceId,
    });
    if (response.ok) return "enrolled";
    const refusal = enrollActorRefusalSchema.safeParse(await response.json().catch(() => null));
    const code = refusal.success ? refusal.data.code : undefined;
    const outcome = code === ACTOR_EMAIL_REQUIRED_CODE ? "email_required" : "unavailable";
    log.warn("control_plane.enroll_actor", {
      ...base,
      outcome,
      http_status: response.status,
      error_code: code,
    });
    return outcome;
  } catch (e) {
    log.warn("control_plane.enroll_actor", {
      ...base,
      outcome: "unavailable",
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return "unavailable";
  }
}
