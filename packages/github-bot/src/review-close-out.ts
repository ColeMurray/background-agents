/**
 * Close out the commit status of a review session whose turn has ended.
 *
 * The bot writes "pending" when a review starts, and the agent replaces it only when it publishes.
 * A turn that ends any other way — the stuck-processing timeout, a cancel, a lost sandbox, a failed
 * submission, a push that replaced its head — is closed out here instead.
 *
 * A close-out is a writer like the agent, so it follows the same ownership rule: it writes only
 * while holding the PR's submission lease, which the control plane grants (as
 * `close-out:<sessionId>`) only to the newest review of its head. It replaces only a status it
 * reads as pending, and reports back — finalize — so the control plane keeps the review's fence row
 * until GitHub shows a terminal status, and re-drives the close-out from its reaper until then.
 */

import { z } from "zod";
import { resolveAppName } from "@open-inspect/shared/app-name";
import type { GitHubReviewCompletionCallback } from "@open-inspect/shared/types/session-api";
import {
  COMMIT_STATUS_DESCRIPTION_MAX_CHARS,
  generateInstallationToken,
  getPullRequestSnapshot,
  getReviewStatusState,
  GITHUB_API_REQUEST_TIMEOUT_MS,
  postCommitStatus,
  REVIEW_DID_NOT_FINISH_PREFIX,
  REVIEW_NOT_PUBLISHED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
  REVIEW_SUPERSEDED_DESCRIPTION,
} from "./github-auth";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Logger } from "./logger";
import type { Env } from "./types";

/**
 * Slack kept between the last status write and the lease's expiry: a write is started only while
 * at least one full request timeout plus this margin of the lease remains.
 */
const CLOSE_OUT_LEASE_MARGIN_MS = 5_000;

/** Why a review's turn ended, recorded once so every later attempt writes the same thing. */
export interface ReviewCloseOutRequest {
  owner: string;
  repo: string;
  /** Null when the ending carried no reason of its own. */
  description: string | null;
}

const closeOutGrantResponseSchema = z.object({
  outcome: z.literal("granted"),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
  description: z.string().nullable(),
  superseded: z.boolean(),
  leaseExpiresInMs: z.number(),
  /** Names this grant's lease: finalize acts only while this grant still holds it. */
  grantId: z.string().min(1),
});

/** The right to write one review's terminal status, held as the PR's submission lease. */
export interface ReviewCloseOutGrant extends z.infer<typeof closeOutGrantResponseSchema> {
  sessionId: string;
  /** When the grant was requested: the lease's expiry is measured from here, conservatively. */
  requestedAt: number;
}

export type ReviewCloseOutRequestResult =
  | { outcome: "granted"; grant: ReviewCloseOutGrant }
  /** Another holder's lease is live, or a stale session is not yet cancelled: the reaper retries. */
  | { outcome: "deferred" }
  /** Nothing is owed: a newer review owns this head's status, or it was already closed out. */
  | { outcome: "not_owned" }
  /** The control plane could not answer; `status` is absent when the request itself failed. */
  | { outcome: "request_failed"; status?: number };

export type ReviewCloseOutOutcome =
  | "closed_out"
  | "already_terminal"
  | "pr_not_open"
  | "lease_budget_exhausted"
  | "status_unreadable"
  | "status_write_failed";

/**
 * The description for a review that ended with its status still pending. A turn that reported
 * success yet left "pending" behind ran to the end without publishing; any other ending carries
 * the session's own reason, so a reader learns the process died rather than that the review
 * found a problem.
 */
export function closeOutDescription(
  callback: Pick<GitHubReviewCompletionCallback, "success" | "error">
): string {
  const reason = callback.error?.trim();
  if (callback.success || !reason) return REVIEW_NOT_PUBLISHED_DESCRIPTION;
  const description = `${REVIEW_DID_NOT_FINISH_PREFIX}${reason}`;
  return description.length <= COMMIT_STATUS_DESCRIPTION_MAX_CHARS
    ? description
    : `${description.slice(0, COMMIT_STATUS_DESCRIPTION_MAX_CHARS - 1)}…`;
}

/**
 * Ask the control plane for a review's close-out lease. `request`, when given, is recorded durably
 * first — it declares the review's turn over, fencing its agent out of the lease for good — so a
 * deferred or failed attempt is re-driven by the control plane's reaper. Without it, this only
 * retries a close-out already requested. Transport failures throw.
 */
export async function requestCloseOut(
  env: Env,
  traceId: string,
  sessionId: string,
  request?: ReviewCloseOutRequest
): Promise<ReviewCloseOutRequestResult> {
  const requestedAt = Date.now();
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: "https://internal/internal/github-reviews/close-out",
    body: JSON.stringify(request ? { sessionId, request } : { sessionId }),
    traceId,
  });
  if (response.status === 202) return { outcome: "deferred" };
  if (response.status === 409) return { outcome: "not_owned" };
  if (response.status !== 200) return { outcome: "request_failed", status: response.status };
  const parsed = closeOutGrantResponseSchema.safeParse(await response.json());
  if (!parsed.success) return { outcome: "request_failed", status: response.status };
  return { outcome: "granted", grant: { ...parsed.data, sessionId, requestedAt } };
}

async function finalizeCloseOut(
  env: Env,
  log: Logger,
  traceId: string,
  grant: ReviewCloseOutGrant,
  outcome: "done" | "retry"
): Promise<void> {
  const { sessionId, grantId } = grant;
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "POST",
      url: "https://internal/internal/github-reviews/close-out/finalize",
      body: JSON.stringify({ sessionId, grantId, outcome }),
      traceId,
    });
    if (!response.ok) {
      log.warn("review_close_out.finalize_failed", {
        session_id: sessionId,
        finalize: outcome,
        status: response.status,
      });
    }
  } catch (error) {
    // The lease still expires on its own, and the row still carries its request: the reaper
    // re-drives it, and the next attempt finds the status already terminal.
    log.warn("review_close_out.finalize_failed", {
      session_id: sessionId,
      finalize: outcome,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

async function writeTerminalStatus(
  env: Env,
  log: Logger,
  grant: ReviewCloseOutGrant,
  meta: Record<string, unknown>
): Promise<{ outcome: ReviewCloseOutOutcome; finalize: "done" | "retry" }> {
  const { owner, repo, prNumber, headSha } = grant;
  const deadline =
    grant.requestedAt +
    grant.leaseExpiresInMs -
    GITHUB_API_REQUEST_TIMEOUT_MS -
    CLOSE_OUT_LEASE_MARGIN_MS;
  const userAgent = resolveAppName(env);
  const token = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  const status = await getReviewStatusState(token, owner, repo, headSha, userAgent);
  if (!status.ok) {
    log.warn("review_close_out.status_unreadable", { ...meta, error: status.error });
    return { outcome: "status_unreadable", finalize: "retry" };
  }
  // The agent published its verdict or marked its PR stale, or an earlier attempt closed it out.
  // A commit with no review status at all (the handler's pending write is best-effort) still
  // needs the terminal one.
  if (status.state !== "pending" && status.state !== null) {
    return { outcome: "already_terminal", finalize: "done" };
  }

  // A review abandoned because its PR merged or closed first is the common ending, and an error
  // on a commit nobody is waiting for is noise. An unreadable PR is not evidence it closed, so the
  // close-out proceeds: a stray status on a closed PR costs less than a pending one on an open PR.
  const pullRequest = await getPullRequestSnapshot(token, owner, repo, prNumber, userAgent);
  if (pullRequest.ok && pullRequest.state !== "open") {
    return { outcome: "pr_not_open", finalize: "done" };
  }

  // GitHub statuses have no compare-and-swap: a write that could land after the lease expires
  // could overwrite the next holder's verdict, so it is never started that late.
  if (Date.now() > deadline) {
    log.warn("review_close_out.lease_budget_exhausted", meta);
    return { outcome: "lease_budget_exhausted", finalize: "retry" };
  }

  const description = grant.superseded
    ? REVIEW_SUPERSEDED_DESCRIPTION
    : (grant.description ?? REVIEW_NOT_PUBLISHED_DESCRIPTION);
  const result = await postCommitStatus(
    token,
    owner,
    repo,
    headSha,
    { state: "error", context: REVIEW_STATUS_CONTEXT, description },
    userAgent
  );
  if (result.ok) {
    log.info("review_close_out.closed_out", { ...meta, description });
    return { outcome: "closed_out", finalize: "done" };
  }
  // Nothing was written, so GitHub still shows what it showed before: keep the close-out for the
  // reaper, whatever the rejection. The control plane gives up on it after a week.
  log.error("review_close_out.status_write_failed", {
    ...meta,
    ...(result.status === undefined ? {} : { github_status: result.status }),
    error: result.error,
  });
  return { outcome: "status_write_failed", finalize: "retry" };
}

/**
 * Write a granted close-out's terminal status, then finalize it: `done` once GitHub shows a
 * terminal status (written, or already there), `retry` otherwise — including when anything here
 * throws — so the control plane keeps the review for its reaper.
 */
export async function completeCloseOut(
  env: Env,
  log: Logger,
  grant: ReviewCloseOutGrant,
  traceId: string
): Promise<ReviewCloseOutOutcome> {
  const meta = {
    trace_id: traceId,
    session_id: grant.sessionId,
    repo: `${grant.owner}/${grant.repo}`.toLowerCase(),
    pull_number: grant.prNumber,
    head_sha: grant.headSha,
    superseded: grant.superseded,
  };
  let finalize: "done" | "retry" = "retry";
  try {
    const result = await writeTerminalStatus(env, log, grant, meta);
    finalize = result.finalize;
    return result.outcome;
  } finally {
    await finalizeCloseOut(env, log, traceId, grant, finalize);
  }
}

/**
 * Request and, when granted, complete a close-out inline — for callers already running in the
 * background, such as a webhook whose review prompt could not be delivered. Never throws: the
 * request is recorded before any failure that matters, and the reaper owns every retry.
 */
export async function closeOutReviewStatus(
  env: Env,
  log: Logger,
  traceId: string,
  params: { sessionId: string; request: ReviewCloseOutRequest }
): Promise<void> {
  const meta = { trace_id: traceId, session_id: params.sessionId };
  try {
    const result = await requestCloseOut(env, traceId, params.sessionId, params.request);
    const outcome =
      result.outcome === "granted"
        ? await completeCloseOut(env, log, result.grant, traceId)
        : result.outcome;
    log.info("review_close_out.handled", { ...meta, outcome });
  } catch (error) {
    log.warn("review_close_out.error", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
