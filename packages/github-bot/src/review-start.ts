/**
 * A PR review's path through startSession: the steps that keep one live review per PR and publish
 * it as the PR head's `open-inspect` status (review supersession). startSession runs them in this
 * order:
 *
 * 1. admitReview — the last step before session creation: freshness check, then generation claim.
 * 2. abandonReview — when creation fails: keep a newer trigger's claim, or roll this one back.
 * 3. beginReview — once the session exists: sweep older reviews, write the "pending" start marker.
 * 4. sendReviewPrompt — deliver the prompt with the review's status target as callback context.
 */

import type { GitHubReviewCallbackContext } from "@open-inspect/shared/types/session-api";
import {
  getPullRequestSnapshot,
  postCommitStatus,
  REVIEW_PENDING_DESCRIPTION,
  REVIEW_START_FAILED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
} from "./github-auth";
import type { Logger } from "./logger";
import { closeOutReviewStatus } from "./review-close-out";
import {
  claimReviewGeneration,
  leaseWriteDeadline,
  releaseReviewGeneration,
  releaseStartMarkerLease,
  requestStartMarkerLease,
  sweepStaleReviews,
  type StartMarkerGrant,
  type StartMarkerLeaseResult,
} from "./review-supersession";
import { PromptRejectedError, sendPrompt, type SessionCreationResult } from "./session-client";
import type { HandlerResult } from "./session-startup";
import type { Env, PullRequestReviewTriggerPayload } from "./types";

/** What a trigger fixes about the review it hands to startSession. */
export interface ReviewRequest {
  /** The head the trigger saw. The review is stale once the PR has moved off it. */
  headSha: string;
  /**
   * The `pull_request` action behind an automatic review. An automatic review skips a PR that has
   * turned draft; a requested review (no action) runs on a draft too.
   */
  trigger?: PullRequestReviewTriggerPayload["action"];
}

/** A review's PR and the installation it acts through, once its trigger passed caller gating. */
export interface ReviewContext extends ReviewRequest {
  env: Env;
  log: Logger;
  traceId: string;
  token: string;
  userAgent: string;
  meta: Record<string, unknown>;
  repoId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

/** The create-session field that fences a review's session to the generation its trigger claimed. */
export interface GitHubReviewFence {
  repoId: number;
  prNumber: number;
  generation: number;
  headSha: string;
  /** Where the review's status lives, so a review that never starts can still be closed out. */
  owner: string;
  repo: string;
}

/** A review whose PR generation is claimed: its session is created under that fence. */
export interface AdmittedReview extends ReviewContext {
  /** Whether the PR was a draft at admission; the review's submission requires it unchanged. */
  draft: boolean;
  githubReview: GitHubReviewFence;
}

interface ReviewStatusTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * How long a start marker may take to get the PR's submission lease before its review starts
 * without one: long enough to wait out another holder's live lease, since holders release right
 * after their own writes. A request the control plane has not answered by then is abandoned, so a
 * stalled control plane holds the prompt back no longer than a busy lease does.
 */
export const START_MARKER_LEASE_WAIT_MS = 5_000;

/** Pause between start-marker lease requests while another holder's lease is live. */
const START_MARKER_LEASE_RETRY_MS = 1_000;

/**
 * Check the live PR against the trigger, then claim the PR's next review generation. This must be
 * the last step before the review's session is created: any earlier network-bound step (routing,
 * target resolution) widens the window in which a close/draft tombstone or newer push could
 * outrank this snapshot.
 */
export async function admitReview(review: ReviewContext): Promise<HandlerResult | AdmittedReview> {
  const { env, log, traceId, token, userAgent, meta, repoId, owner, repo, prNumber, headSha } =
    review;
  const freshness = await getPullRequestSnapshot(token, owner, repo, prNumber, userAgent);
  if (!freshness.ok) {
    log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
    return { outcome: "skipped", skip_reason: "freshness_check_failed" };
  }
  // A requested review runs on a draft; an automatic one stops once the PR has turned draft.
  const draftStale = review.trigger !== undefined && freshness.draft;
  if (freshness.headSha !== headSha || freshness.state !== "open" || draftStale) {
    log.debug("handler.stale_head_sha", {
      ...meta,
      current_head_sha: freshness.headSha,
      expected_head_sha: headSha,
      state: freshness.state,
      draft: freshness.draft,
    });
    return { outcome: "skipped", skip_reason: "stale_head_sha" };
  }

  const generation = await claimReviewGeneration(env, traceId, { repoId, prNumber });
  return {
    ...review,
    draft: freshness.draft,
    githubReview: { repoId, prNumber, generation, headSha, owner, repo },
  };
}

/**
 * Settle the claim of a review whose session was not created: `creation` is the refused creation,
 * or absent when creation threw. A 409 without a refusal code means a newer trigger claimed the
 * PR's generation first, so its claim must stand and the review is skipped. After any other
 * failure the claim bumped the fence but no session will ever carry it: it is rolled back so a
 * review still running on the previous generation is not permanently locked out of submitting,
 * and null leaves the failure to the caller.
 */
export async function abandonReview(
  review: AdmittedReview,
  creation?: Extract<SessionCreationResult, { ok: false }>
): Promise<HandlerResult | null> {
  const { env, log, traceId, meta, githubReview } = review;
  if (creation?.status === 409 && creation.code === undefined) {
    log.info("handler.review_superseded", { ...meta, generation: githubReview.generation });
    return { outcome: "skipped", skip_reason: "superseded" };
  }
  await releaseReviewGeneration(env, log, traceId, githubReview);
  return null;
}

/**
 * Retire every older review of the PR, then mark this one in progress on its head. Both steps are
 * best-effort: neither may stop a review whose session already exists.
 */
export async function beginReview(review: AdmittedReview, sessionId: string): Promise<void> {
  const { env, log, traceId, token, userAgent, meta, githubReview } = review;
  await sweepStaleReviews(env, log, traceId, githubReview);
  await postPendingReviewStatus(env, log, traceId, sessionId, token, review, userAgent, meta);
}

/** The code-review prompt fields that come from the review's admission. */
export function reviewPromptFields(review: AdmittedReview | undefined) {
  // startSession hands every review it admitted to the prompt builder.
  if (!review) throw new Error("Review prompt built without an admitted review");
  return { headSha: review.headSha, isDraft: review.draft };
}

/**
 * The PR's submission lease for a review's start marker, or null when the marker must not or
 * cannot be written now. Another holder's live lease is waited out for a few seconds: holders
 * release right after their own writes.
 */
async function acquireStartMarkerLease(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  meta: Record<string, unknown>
): Promise<StartMarkerGrant | null> {
  const giveUpAt = Date.now() + START_MARKER_LEASE_WAIT_MS;
  // On setTimeout rather than AbortSignal.timeout, so it runs on the same clock as the retries.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Start-marker lease wait ran out", "TimeoutError")),
    START_MARKER_LEASE_WAIT_MS
  );
  try {
    for (;;) {
      let result: StartMarkerLeaseResult;
      try {
        result = await requestStartMarkerLease(env, traceId, sessionId, deadline.signal);
      } catch (error) {
        log.warn("review_status.lease_request_failed", {
          ...meta,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return null;
      }
      switch (result.outcome) {
        case "granted":
          return result.grant;
        case "superseded":
          log.info("review_status.superseded", meta);
          return null;
        case "request_failed":
          log.warn("review_status.lease_request_failed", { ...meta, status: result.status });
          return null;
        case "busy":
          if (Date.now() + START_MARKER_LEASE_RETRY_MS > giveUpAt) {
            log.warn("review_status.lease_busy", meta);
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, START_MARKER_LEASE_RETRY_MS));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a just-admitted review as in progress. The start marker is written like every other status
 * on a review's head: holding the PR's submission lease, which is granted only while this review
 * is still its PR's latest and its turn has not been closed out. So a review superseded or closed
 * out before it gets here writes none. And none lands after its review's close-out has read the
 * head — that close-out would finalize the review's fence and leave "pending" behind for good —
 * given that GitHub lands a write within the request timeout or never: the assumption
 * leaseWriteDeadline, a close-out's write deadline too, rests on.
 *
 * Best-effort, as the start marker always was: when the lease cannot be had, the review runs
 * without one, and its verdict or close-out still writes the terminal status.
 */
async function postPendingReviewStatus(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  token: string,
  target: ReviewStatusTarget,
  userAgent: string,
  meta: Record<string, unknown>
): Promise<void> {
  const statusMeta = { ...meta, head_sha: target.headSha, state: "pending" };
  const grant = await acquireStartMarkerLease(env, log, traceId, sessionId, statusMeta);
  if (!grant) return;
  // Like a close-out's write, never started so late that it could land after the lease expires.
  if (Date.now() > leaseWriteDeadline(grant)) {
    log.warn("review_status.lease_budget_exhausted", statusMeta);
    await releaseStartMarkerLease(env, log, traceId, sessionId, grant.grantId);
    return;
  }

  const result = await postCommitStatus(
    token,
    target.owner,
    target.repo,
    target.headSha,
    {
      state: "pending",
      context: REVIEW_STATUS_CONTEXT,
      description: REVIEW_PENDING_DESCRIPTION,
    },
    userAgent
  );
  // Released once GitHub has settled the write: landed it, or refused it with a 4xx. After a 5xx,
  // a transport error or a timeout the write may still land, so the lease is left to expire: a
  // close-out then reads the head only once the write has landed or never will.
  const settled =
    result.ok || (result.status !== undefined && result.status >= 400 && result.status < 500);
  if (settled) {
    await releaseStartMarkerLease(env, log, traceId, sessionId, grant.grantId);
  }
  if (result.ok) {
    log.debug("review_status.posted", statusMeta);
    return;
  }
  log.warn("review_status.failed", {
    ...statusMeta,
    ...(result.status === undefined ? {} : { github_status: result.status }),
    error: result.error,
  });
}

/**
 * Deliver a review prompt with a callback context naming the commit its "pending" status sits on,
 * so the session's end comes back to `/callbacks/complete` however the agent stops — including the
 * endings (timeout, cancel, a lost sandbox) that never reach the prompt's own submission step.
 *
 * A session whose prompt never arrives has no turn to end, so no callback will ever close it out.
 * When the control plane definitively rejected the prompt (a 4xx), its close-out is requested
 * here, through the same lease as every other. Any other failure — a transport error, a 5xx, an
 * unreadable answer — is ambiguous: the prompt may have been accepted, and recording a close-out
 * would fence out a live review. Those are left to the control plane's reaper, which asks the
 * session itself after a grace period and closes it out only if it holds no prompt.
 */
export async function sendReviewPrompt(
  review: AdmittedReview,
  sessionId: string,
  message: { content: string; authorId: string }
): Promise<string> {
  const { env, log, traceId, owner, repo, prNumber, headSha } = review;
  const callbackContext: GitHubReviewCallbackContext = {
    source: "github",
    owner,
    repo,
    prNumber,
    headSha,
  };
  try {
    return await sendPrompt(env, traceId, sessionId, { ...message, callbackContext });
  } catch (error) {
    if (error instanceof PromptRejectedError) {
      await closeOutReviewStatus(env, log, traceId, {
        sessionId,
        request: { owner, repo, description: REVIEW_START_FAILED_DESCRIPTION },
      });
    }
    throw error;
  }
}
