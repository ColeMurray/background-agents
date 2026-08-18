/**
 * GitHub review supersession (fix A): D1-fenced generations that let a new
 * review trigger for a PR cancel any stale in-flight review session for the
 * same PR, race-safely, via the control plane's github-reviews routes.
 */

import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";
import type { Logger } from "./logger";

export interface ReviewIdentity {
  repoId: number;
  prNumber: number;
}

const claimReviewGenerationResponseSchema = z.object({
  generation: z.number(),
});

const sweepStaleReviewsResponseSchema = z.object({
  cancelledSessionIds: z.array(z.string()),
  failedSessionIds: z.array(z.string()),
});

/**
 * Atomically bump (or create) the review generation counter for a PR and
 * return the newly claimed generation. Every subsequent step (session
 * creation, sweep) is scoped to this generation.
 */
export async function claimReviewGeneration(
  env: Env,
  traceId: string,
  params: ReviewIdentity
): Promise<number> {
  const url = "https://internal/internal/github-reviews/claim";
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: JSON.stringify({ repoId: params.repoId, prNumber: params.prNumber }),
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Review generation claim failed: ${response.status} ${body}`);
  }
  const parsed = claimReviewGenerationResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Review generation claim failed: invalid response");
  }
  return parsed.data.generation;
}

/**
 * Roll back a generation this bot claimed but never used, because its own
 * session creation failed for a reason other than supersession.
 *
 * Without this, the abandoned bump permanently outranks a review session
 * still running from the previous generation: that session fails its
 * ownership check and never submits, while no replacement exists. The control
 * plane applies the rollback only while the claim is still the latest and
 * unused, so a newer trigger's claim is never disturbed.
 *
 * Best-effort: a failed compensation must not mask the original create error,
 * so this never throws.
 */
export async function releaseReviewGeneration(
  env: Env,
  log: Logger,
  traceId: string,
  params: ReviewIdentity & { generation: number }
): Promise<void> {
  const meta = {
    trace_id: traceId,
    repo_id: params.repoId,
    pull_number: params.prNumber,
    generation: params.generation,
  };
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "POST",
      url: "https://internal/internal/github-reviews/release-claim",
      body: JSON.stringify({
        repoId: params.repoId,
        prNumber: params.prNumber,
        generation: params.generation,
      }),
      traceId,
    });
    if (!response.ok) {
      log.warn("review_claim.release_failed", { ...meta, status: response.status });
      return;
    }
    log.info("review_claim.released", meta);
  } catch (error) {
    log.warn("review_claim.release_error", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Cancel every review session recorded for this PR with a generation older
 * than `generation`. Best-effort: a sweep failure must never block the new
 * review session that was already created, so this never throws.
 */
export async function sweepStaleReviews(
  env: Env,
  log: Logger,
  traceId: string,
  params: ReviewIdentity & { generation: number }
): Promise<void> {
  const meta = {
    trace_id: traceId,
    repo_id: params.repoId,
    pull_number: params.prNumber,
    generation: params.generation,
  };
  try {
    const url = "https://internal/internal/github-reviews/sweep";
    const response = await signedControlPlaneFetch(env, {
      method: "POST",
      url,
      body: JSON.stringify({
        repoId: params.repoId,
        prNumber: params.prNumber,
        generation: params.generation,
      }),
      traceId,
    });
    if (!response.ok) {
      log.warn("review_sweep.request_failed", { ...meta, status: response.status });
      return;
    }
    const parsed = sweepStaleReviewsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log.warn("review_sweep.invalid_response", meta);
      return;
    }
    if (parsed.data.failedSessionIds.length > 0) {
      log.warn("review_sweep.partial_failure", {
        ...meta,
        cancelled_session_ids: parsed.data.cancelledSessionIds,
        failed_session_ids: parsed.data.failedSessionIds,
      });
      return;
    }
    log.info("review_sweep.completed", {
      ...meta,
      cancelled_session_ids: parsed.data.cancelledSessionIds,
    });
  } catch (error) {
    log.warn("review_sweep.error", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
