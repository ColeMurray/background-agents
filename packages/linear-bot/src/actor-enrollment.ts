import { enrollActor } from "@open-inspect/shared/actor-enrollment";
import { abortable } from "@open-inspect/shared/abortable";
import {
  ACTOR_ADMISSION_DENIED_CODE,
  ACTOR_EMAIL_REQUIRED_CODE,
} from "@open-inspect/shared/types/actors";
import type { Env } from "./types";
import { fetchUser, type LinearApiClient } from "./utils/linear-client";
import { createLogger } from "./logger";

export const ACTOR_ENROLLMENT_TIMEOUT_MS = 10_000;
const log = createLogger("actor-enrollment");

export function describeActorAdmissionFailure(code: string): string | null {
  if (code === ACTOR_EMAIL_REQUIRED_CODE) {
    return "Cannot link your Linear account because its email is unavailable. Ask an administrator to check that the bot can read your Linear email.";
  }
  if (code === ACTOR_ADMISSION_DENIED_CODE) {
    return "Your account is not authorized to join this Open-Inspect workspace. Sign in on the web with your Linear email, or ask an administrator to check the admission allowlists.";
  }
  return null;
}

/** First-time collaborators must present their email before claim-less requests. */
export async function enrollLinearActor(
  env: Env,
  client: LinearApiClient,
  actorUserId: string,
  traceId: string
): Promise<string | null> {
  const context = { trace_id: traceId, actor: `linear:${actorUserId}` };
  try {
    const signal = AbortSignal.timeout(ACTOR_ENROLLMENT_TIMEOUT_MS);
    const profile = await abortable(fetchUser(client, actorUserId, signal), signal);
    const result = await enrollActor(
      "linear-bot",
      env,
      {
        actor: context.actor,
        profile: { displayName: profile?.name, email: profile?.email ?? undefined },
        traceId,
      },
      signal
    );
    if (result.outcome === "enrolled") return null;
    const message =
      result.outcome !== "unavailable" && result.errorCode
        ? describeActorAdmissionFailure(result.errorCode)
        : null;
    log.warn("control_plane.enroll_actor", {
      ...context,
      outcome: message ? "denied" : "unavailable",
      http_status: result.httpStatus,
      error_code: result.errorCode,
      error: result.error,
    });
    if (message) return message;
  } catch (error) {
    log.warn("control_plane.enroll_actor", {
      ...context,
      outcome: "unavailable",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return "Cannot verify your Open-Inspect account right now. Please retry or ask an administrator to check your workspace access.";
}
