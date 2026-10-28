import { enrollActor } from "@open-inspect/shared/actor-enrollment";
import { abortable } from "@open-inspect/shared/abortable";
import {
  ACTOR_ADMISSION_DENIED_CODE,
  ACTOR_EMAIL_REQUIRED_CODE,
  type ActorProfileClaims,
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

/** Resolve known actors without a profile lookup; unknown actors must attest their email. */
export async function enrollLinearActor(
  env: Env,
  client: LinearApiClient,
  actorUserId: string,
  traceId: string
): Promise<string | null> {
  const context = { trace_id: traceId, actor: `linear:${actorUserId}` };
  let httpStatus: number | undefined;
  try {
    const signal = AbortSignal.timeout(ACTOR_ENROLLMENT_TIMEOUT_MS);
    let claims: ActorProfileClaims = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await enrollActor(
        "linear-bot",
        env,
        { actor: context.actor, profile: claims, traceId },
        signal
      );
      httpStatus = result.httpStatus ?? httpStatus;
      if (result.outcome === "enrolled") return null;
      if (attempt === 0 && result.outcome === "email_required") {
        const profile = await abortable(fetchUser(client, actorUserId, signal), signal);
        claims = { displayName: profile?.name, email: profile?.email ?? undefined };
        continue;
      }
      const message =
        result.outcome !== "unavailable" && result.errorCode
          ? describeActorAdmissionFailure(result.errorCode)
          : null;
      log.warn("control_plane.enroll_actor", {
        ...context,
        outcome: message ? "denied" : "unavailable",
        http_status: httpStatus,
        error_code: result.errorCode,
        error: result.error,
      });
      if (message) return message;
      break;
    }
  } catch (error) {
    log.warn("control_plane.enroll_actor", {
      ...context,
      outcome: "unavailable",
      http_status: httpStatus,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return "Cannot verify your Open-Inspect account right now. Please retry or ask an administrator to check your workspace access.";
}
