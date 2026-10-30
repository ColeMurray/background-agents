import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

const REVIEW_SUPERSESSION_URL = "https://internal/github-reviews/supersede";

const supersessionResponseSchema = z.object({
  displacedSessionIds: z.array(z.string()),
});

/**
 * Record this session as the pull request's current review and cancel the one
 * it replaced. Actorless: the sender of the new review may not be allowed to
 * stop a session the previous sender owns.
 */
export async function supersedeInFlightReview(
  env: Env,
  traceId: string,
  params: { sessionId: string; repositoryId: number; pullNumber: number }
): Promise<void> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: REVIEW_SUPERSESSION_URL,
    body: JSON.stringify({
      sessionId: params.sessionId,
      repositoryId: params.repositoryId,
      pullNumber: params.pullNumber,
    }),
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Review supersession failed: ${response.status} ${body}`);
  }
  const parsed = supersessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Review supersession failed: invalid response");
  }
}
