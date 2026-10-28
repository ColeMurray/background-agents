import { z } from "zod";
import { abortable } from "./abortable";
import {
  signedControlPlaneFetch,
  type FetchClient,
  type OutboundCredentialEnv,
  type ServiceName,
} from "./service-auth";
import {
  ACTOR_ADMISSION_DENIED_CODE,
  ACTOR_EMAIL_REQUIRED_CODE,
  type ActorProfileClaims,
  type ActorEnrollmentOutcome,
} from "./types/actors";

const refusalSchema = z.object({ code: z.string() });

export interface ActorEnrollmentResult {
  outcome: ActorEnrollmentOutcome;
  httpStatus?: number;
  errorCode?: string;
  error?: Error;
}

/**
 * Enroll an actor using attested profile claims. The caller supplies a deadline
 * (which may also cover profile lookup) and owns logging and user-facing copy.
 */
export async function enrollActor(
  service: ServiceName,
  env: OutboundCredentialEnv & { CONTROL_PLANE: FetchClient },
  request: { actor: string; profile: ActorProfileClaims; traceId?: string },
  signal: AbortSignal
): Promise<ActorEnrollmentResult> {
  let httpStatus: number | undefined;
  try {
    signal.throwIfAborted();
    const response = await abortable(
      signedControlPlaneFetch(
        service,
        env,
        {
          method: "POST",
          url: "https://internal/actors/me",
          actor: request.actor,
          body: JSON.stringify(request.profile),
          traceId: request.traceId,
        },
        { signal }
      ),
      signal
    );
    httpStatus = response.status;
    if (response.ok) return { outcome: "enrolled", httpStatus };
    const body = await abortable(
      response.json().catch(() => null),
      signal
    );
    const refusal = refusalSchema.safeParse(body);
    const errorCode = refusal.success ? refusal.data.code : undefined;
    let outcome: ActorEnrollmentOutcome = "unavailable";
    if (httpStatus === 403) {
      if (errorCode === ACTOR_EMAIL_REQUIRED_CODE) outcome = "email_required";
      if (errorCode === ACTOR_ADMISSION_DENIED_CODE) outcome = "admission_denied";
    }
    return { outcome, httpStatus, errorCode };
  } catch (error) {
    return {
      outcome: "unavailable",
      httpStatus,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
