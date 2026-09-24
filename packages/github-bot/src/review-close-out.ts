/**
 * Close out the commit status of a review session whose turn has ended.
 *
 * The bot writes "pending" when a review starts, and until now only the agent itself ever replaced
 * it — from inside its prompt. A turn the control plane ends from outside (the stuck-processing
 * timeout, a cancel, a lost sandbox) never reaches that step, so the status stayed pending forever:
 * indistinguishable from a review still running. The control plane's completion callback reaches
 * this module on every ending, and this is the one place a terminal status is written for it.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import type { GitHubReviewCompletionCallback } from "@open-inspect/shared/types/session-api";
import {
  COMMIT_STATUS_DESCRIPTION_MAX_CHARS,
  generateInstallationToken,
  getPullRequestSnapshot,
  getReviewStatusState,
  postCommitStatus,
  REVIEW_DID_NOT_FINISH_PREFIX,
  REVIEW_NOT_PUBLISHED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
} from "./github-auth";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Logger } from "./logger";
import type { Env } from "./types";

export type ReviewCloseOutOutcome =
  | "closed_out"
  | "not_owned"
  | "already_terminal"
  | "pr_not_open"
  | "close_out_claim_failed"
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
 * Ask the control plane for the right to write this session's terminal status. It is granted only
 * while the session is still its PR's latest review and holds no live submission lease, and
 * granting it fences the session out of any later write — so an agent that wakes after its turn
 * was failed cannot publish over the close-out, and a successor's own status is never touched.
 */
async function claimCloseOut(
  env: Env,
  traceId: string,
  sessionId: string
): Promise<"owned" | "not_owned" | "failed"> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: "https://internal/internal/github-reviews/close-out",
    body: JSON.stringify({ sessionId }),
    traceId,
  });
  if (response.status === 204) return "owned";
  if (response.status === 409) return "not_owned";
  return "failed";
}

export async function closeOutEndedReview(
  env: Env,
  log: Logger,
  callback: GitHubReviewCompletionCallback,
  traceId: string
): Promise<ReviewCloseOutOutcome> {
  const { owner, repo, prNumber, headSha } = callback.context;
  const meta = {
    trace_id: traceId,
    session_id: callback.sessionId,
    message_id: callback.messageId,
    repo: `${owner}/${repo}`.toLowerCase(),
    pull_number: prNumber,
    head_sha: headSha,
    success: callback.success,
  };

  // The claim comes before the status read, never after: once it is granted the agent can no longer
  // publish, so the state read next is final. Read first and a verdict could land in between, only
  // to be overwritten by the error written below.
  const claim = await claimCloseOut(env, traceId, callback.sessionId);
  if (claim === "not_owned") return "not_owned";
  if (claim === "failed") {
    log.warn("review_close_out.claim_failed", meta);
    return "close_out_claim_failed";
  }

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
    return "status_unreadable";
  }
  // The agent published its verdict, or already closed the status out itself.
  if (status.state !== "pending") return "already_terminal";

  // A review abandoned because its PR merged or closed first is the common ending, and an error
  // on a commit nobody is waiting for is noise. An unreadable PR is not evidence it closed, so the
  // close-out proceeds: a stray status on a closed PR costs less than a pending one on an open PR.
  const pullRequest = await getPullRequestSnapshot(token, owner, repo, prNumber, userAgent);
  if (pullRequest.ok && pullRequest.state !== "open") return "pr_not_open";

  const description = closeOutDescription(callback);
  const result = await postCommitStatus(
    token,
    owner,
    repo,
    headSha,
    { state: "error", context: REVIEW_STATUS_CONTEXT, description },
    userAgent
  );
  if (!result.ok) {
    log.error("review_close_out.status_write_failed", {
      ...meta,
      ...(result.status === undefined ? {} : { github_status: result.status }),
      error: result.error,
    });
    return "status_write_failed";
  }
  log.info("review_close_out.closed_out", { ...meta, description });
  return "closed_out";
}
