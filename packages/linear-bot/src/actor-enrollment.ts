import { z } from "zod";
import type { Env } from "./types";
import { signedControlPlaneFetch } from "./internal-auth";
import { fetchUser, type LinearApiClient } from "./utils/linear-client";

export function describeActorAdmissionFailure(code: string): string | null {
  if (code === "actor_email_required") {
    return "Cannot link your Linear account because its email is unavailable. Ask an administrator to check that the bot can read your Linear email.";
  }
  if (code === "actor_admission_denied") {
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
  try {
    const profile = await fetchUser(client, actorUserId);
    const response = await signedControlPlaneFetch(env, {
      method: "POST",
      url: "https://internal/actors/me",
      actor: `linear:${actorUserId}`,
      body: JSON.stringify({ displayName: profile?.name, email: profile?.email ?? undefined }),
      traceId,
    });
    if (response.ok) return null;
    const refusal = z
      .object({ code: z.string() })
      .safeParse(await response.json().catch(() => null));
    if (response.status === 403 && refusal.success) {
      const message = describeActorAdmissionFailure(refusal.data.code);
      if (message) return message;
    }
  } catch {
    // No further actor-bearing requests are safe until enrollment succeeds.
  }
  return "Cannot verify your Open-Inspect account right now. Please retry or ask an administrator to check your workspace access.";
}
