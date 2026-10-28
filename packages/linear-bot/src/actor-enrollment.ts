import { z } from "zod";
import type { Env } from "./types";
import { signedControlPlaneFetch } from "./internal-auth";
import { fetchUser, type LinearApiClient } from "./utils/linear-client";
import { abortable } from "./utils/abortable";
import { createLogger } from "./logger";
import type { ActorProfileClaims } from "@open-inspect/shared/types/actors";

export const ACTOR_ENROLLMENT_TIMEOUT_MS = 10_000;
const log = createLogger("actor-enrollment");

export function describeActorAdmissionFailure(code: string): string | null {
  if (code === "actor_email_required") {
    return "Cannot link your Linear account because its email is unavailable. Ask an administrator to check that the bot can read your Linear email.";
  }
  if (code === "actor_admission_denied") {
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
      const response = await abortable(
        signedControlPlaneFetch(
          env,
          {
            method: "POST",
            url: "https://internal/actors/me",
            actor: context.actor,
            body: JSON.stringify(claims),
            traceId,
          },
          { signal }
        ),
        signal
      );
      httpStatus = response.status;
      if (response.ok) return null;
      const body = await abortable(
        response.json().catch(() => null),
        signal
      );
      const refusal = z.object({ code: z.string() }).safeParse(body);
      if (
        attempt === 0 &&
        response.status === 403 &&
        refusal.success &&
        refusal.data.code === "actor_email_required"
      ) {
        const profile = await abortable(fetchUser(client, actorUserId, signal), signal);
        claims = { displayName: profile?.name, email: profile?.email ?? undefined };
        continue;
      }
      const message =
        response.status === 403 && refusal.success
          ? describeActorAdmissionFailure(refusal.data.code)
          : null;
      log.warn("control_plane.enroll_actor", {
        ...context,
        outcome: message ? "denied" : "unavailable",
        http_status: httpStatus,
        error_code: refusal.success ? refusal.data.code : undefined,
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
