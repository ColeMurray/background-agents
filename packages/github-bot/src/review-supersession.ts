/**
 * GitHub review supersession (fix A): D1-fenced generations that let a new
 * review trigger for a PR cancel any stale in-flight review session for the
 * same PR, race-safely, via the control plane's github-reviews routes.
 */

import { z } from "zod";
import { GITHUB_API_REQUEST_TIMEOUT_MS } from "./github-auth";
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
  deferredSessionIds: z.array(z.string()),
  failedSessionIds: z.array(z.string()),
});

const startMarkerGrantResponseSchema = z.object({
  /** Names this grant's lease: release acts only while this grant still holds it. */
  grantId: z.string().min(1),
  leaseExpiresInMs: z.number(),
});

/**
 * Slack kept between a leased status write and the lease's expiry: a write is started only while
 * at least one full request timeout plus this margin of the lease remains.
 */
const LEASE_WRITE_MARGIN_MS = 5_000;

/**
 * How long a start marker's lease release may take. The review's prompt waits for it, and a
 * release that never arrives costs only the start marker's short lease, which then expires.
 */
export const START_MARKER_RELEASE_TIMEOUT_MS = 2_000;

/** A grant of the PR's submission lease, as the control plane returned it. */
export interface ReviewLeaseGrant {
  leaseExpiresInMs: number;
  /** When the grant was requested: the lease's expiry is measured from here, conservatively. */
  requestedAt: number;
}

/**
 * The last moment a status write may start under `grant` and still land before it expires, given
 * that GitHub lands a write within the request timeout or never. The timeout bounds only how long
 * this client waits, not GitHub's side, so the deadline rests on that assumption.
 */
export function leaseWriteDeadline(grant: ReviewLeaseGrant): number {
  return (
    grant.requestedAt +
    grant.leaseExpiresInMs -
    GITHUB_API_REQUEST_TIMEOUT_MS -
    LEASE_WRITE_MARGIN_MS
  );
}

/** The right to write one review's "pending" start marker, held as the PR's submission lease. */
export interface StartMarkerGrant extends ReviewLeaseGrant {
  grantId: string;
}

export type StartMarkerLeaseResult =
  | { outcome: "granted"; grant: StartMarkerGrant }
  /** Another holder's lease is live: the review is still eligible and may ask again. */
  | { outcome: "busy" }
  /** The review was superseded or closed out: its start marker must not be written. */
  | { outcome: "superseded" }
  /** The control plane answered with neither a grant nor a refusal. */
  | { outcome: "request_failed"; status: number };

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
 * than `generation`. `owner`/`repo` let the control plane record a close-out
 * for a review whose head a push replaced, so its pending status is closed
 * out under the submission lease like any other ending. Best-effort: a sweep
 * failure must never block the new review session that was already created,
 * so this never throws.
 */
export async function sweepStaleReviews(
  env: Env,
  log: Logger,
  traceId: string,
  params: ReviewIdentity & { generation: number; owner: string; repo: string }
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
        owner: params.owner,
        repo: params.repo,
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
        deferred_session_ids: parsed.data.deferredSessionIds,
        failed_session_ids: parsed.data.failedSessionIds,
      });
      return;
    }
    log.info("review_sweep.completed", {
      ...meta,
      cancelled_session_ids: parsed.data.cancelledSessionIds,
      deferred_session_ids: parsed.data.deferredSessionIds,
    });
  } catch (error) {
    log.warn("review_sweep.error", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Ask the control plane for the PR's submission lease to write this review's "pending" start
 * marker. Transport failures throw, as does `signal` ending the request.
 */
export async function requestStartMarkerLease(
  env: Env,
  traceId: string,
  sessionId: string,
  signal: AbortSignal
): Promise<StartMarkerLeaseResult> {
  const requestedAt = Date.now();
  const response = await signedControlPlaneFetch(
    env,
    {
      method: "POST",
      url: "https://internal/internal/github-reviews/start-marker",
      body: JSON.stringify({ sessionId }),
      traceId,
    },
    { signal }
  );
  if (response.status === 423) return { outcome: "busy" };
  if (response.status === 409) return { outcome: "superseded" };
  if (response.status !== 200) return { outcome: "request_failed", status: response.status };
  const parsed = startMarkerGrantResponseSchema.safeParse(await response.json());
  if (!parsed.success) return { outcome: "request_failed", status: response.status };
  return { outcome: "granted", grant: { ...parsed.data, requestedAt } };
}

/**
 * Release a start marker's lease once GitHub has settled its write. Best-effort: a lease left
 * behind expires on its own, so this never throws, and gives up after
 * START_MARKER_RELEASE_TIMEOUT_MS.
 */
export async function releaseStartMarkerLease(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  grantId: string
): Promise<void> {
  const meta = { trace_id: traceId, session_id: sessionId };
  // On setTimeout rather than AbortSignal.timeout, like the lease wait before it.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Start-marker lease release timed out", "TimeoutError")),
    START_MARKER_RELEASE_TIMEOUT_MS
  );
  try {
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "POST",
        url: "https://internal/internal/github-reviews/start-marker/release",
        body: JSON.stringify({ sessionId, grantId }),
        traceId,
      },
      { signal: timeout.signal }
    );
    if (!response.ok) {
      log.warn("review_status.lease_release_failed", { ...meta, status: response.status });
    }
  } catch (error) {
    log.warn("review_status.lease_release_failed", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  } finally {
    clearTimeout(timer);
  }
}
