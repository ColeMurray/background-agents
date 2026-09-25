import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type GitHubReviewCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { signedControlPlaneFetch } from "./internal-auth";
import type {
  Env,
  PullRequestReviewTriggerPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postCommitStatus,
  postReaction,
  checkSenderPermission,
  getPullRequestSnapshot,
  REVIEW_PENDING_DESCRIPTION,
  REVIEW_START_FAILED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
} from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { resolveSessionTarget, type SessionTargetFields } from "./session-target";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import { containsBotMention, stripBotMention } from "./github-mention";
import { closeOutReviewStatus } from "./review-close-out";
import {
  claimReviewGeneration,
  releaseReviewGeneration,
  sweepStaleReviews,
} from "./review-supersession";

export type HandlerResult =
  | {
      outcome: "processed";
      handler_action: string;
      session_id?: string;
      message_id?: string;
    }
  | { outcome: "skipped"; skip_reason: string };

/** Session creation was rejected because a newer review claimed the PR's generation first. */
class ReviewSupersededError extends Error {}

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.requested_reviewer?.login === botUsername;
}

async function createSession(
  env: Env,
  traceId: string,
  params: {
    target: SessionTargetFields;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    scmLogin: string;
    scmUserId: string;
    scmAvatarUrl: string;
    githubReview?: {
      repoId: number;
      prNumber: number;
      generation: number;
      headSha: string;
      owner: string;
      repo: string;
    };
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    ...params.target,
    title: params.title,
    model: params.model,
    scmLogin: params.scmLogin,
    scmAvatarUrl: params.scmAvatarUrl,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  if (params.githubReview) {
    body.githubReview = params.githubReview;
  }
  const url = "https://internal/sessions";
  const bodyText = JSON.stringify(body);
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: `github:${params.scmUserId}`,
    traceId,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (params.githubReview && response.status === 409) {
      throw new ReviewSupersededError(`Session creation superseded: ${errorBody}`);
    }
    throw new Error(`Session creation failed: ${response.status} ${errorBody}`);
  }
  const result = createSessionResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Session creation failed: invalid response");
  }
  return result.data.sessionId;
}

async function sendPrompt(
  env: Env,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string; callbackContext?: GitHubReviewCallbackContext }
): Promise<string> {
  const url = `https://internal/sessions/${sessionId}/prompt`;
  const bodyText = JSON.stringify({
    content: params.content,
    source: "github",
    ...(params.callbackContext ? { callbackContext: params.callbackContext } : {}),
  });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: params.authorId.startsWith("github:") ? params.authorId : undefined,
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = sendPromptResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  return result.data.messageId;
}

async function withReaction<T>(
  log: Logger,
  token: string,
  url: string,
  userAgent: string,
  meta: Record<string, unknown>,
  action: () => Promise<T>
): Promise<T> {
  const reaction = postReaction(token, url, "eyes", userAgent).then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
  try {
    return await action();
  } finally {
    await reaction;
  }
}

interface ReviewStatusTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Mark a just-admitted review as in progress. The one commit-status write made without the PR's
 * submission lease: it is the start marker for the generation this handler has just admitted.
 */
async function postPendingReviewStatus(
  log: Logger,
  token: string,
  target: ReviewStatusTarget,
  userAgent: string,
  meta: Record<string, unknown>
): Promise<void> {
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
  const statusMeta = { ...meta, head_sha: target.headSha, state: "pending" };
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
 * A session whose prompt never arrives has no turn to end, so no callback will ever close it out:
 * its close-out is requested here instead, through the same lease as every other.
 */
async function sendReviewPrompt(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string },
  target: ReviewStatusTarget
): Promise<string> {
  const callbackContext: GitHubReviewCallbackContext = { source: "github", ...target };
  try {
    return await sendPrompt(env, traceId, sessionId, {
      content: params.content,
      authorId: params.authorId,
      callbackContext,
    });
  } catch (error) {
    await closeOutReviewStatus(env, log, traceId, {
      sessionId,
      request: {
        owner: target.owner,
        repo: target.repo,
        description: REVIEW_START_FAILED_DESCRIPTION,
      },
    });
    throw error;
  }
}

type CallerGatingResult =
  | { allowed: true; ghToken: string }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  if (config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed" };
    }
  }

  const userAgent = resolveAppName(env);
  const ghToken = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin,
      userAgent
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason };
    }
  }

  return { allowed: true, ghToken };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  const userAgent = resolveAppName(env);
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    userAgent,
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });

      // Freshness runs as the last await before claim: any earlier network-bound
      // step (target resolution) widens the window in which a close/draft
      // tombstone or newer push could outrank this snapshot.
      const freshness = await getPullRequestSnapshot(
        ghToken,
        owner,
        repoName,
        pr.number,
        userAgent
      );
      if (!freshness.ok) {
        log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
        return { outcome: "skipped", skip_reason: "freshness_check_failed" };
      }
      if (freshness.headSha !== pr.head.sha || freshness.state !== "open") {
        log.debug("handler.stale_head_sha", {
          ...meta,
          current_head_sha: freshness.headSha,
          expected_head_sha: pr.head.sha,
          state: freshness.state,
          draft: freshness.draft,
        });
        return { outcome: "skipped", skip_reason: "stale_head_sha" };
      }

      const generation = await claimReviewGeneration(env, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
      });

      let sessionId: string;
      try {
        sessionId = await createSession(env, traceId, {
          target,
          title: `GitHub: Review PR #${pr.number}`,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          scmLogin: sender.login,
          scmUserId: String(sender.id),
          scmAvatarUrl: sender.avatar_url,
          githubReview: {
            repoId: repo.id,
            prNumber: pr.number,
            generation,
            headSha: pr.head.sha,
            owner,
            repo: repoName,
          },
        });
      } catch (error) {
        if (error instanceof ReviewSupersededError) {
          // A newer trigger already owns the fence; its claim must stand.
          log.info("handler.review_superseded", { ...meta, generation });
          return { outcome: "skipped", skip_reason: "superseded" };
        }
        // The claim bumped the fence but no session will ever carry it. Roll it
        // back so a review still running on the previous generation is not
        // permanently locked out of submitting.
        await releaseReviewGeneration(env, log, traceId, {
          repoId: repo.id,
          prNumber: pr.number,
          generation,
        });
        throw error;
      }

      await sweepStaleReviews(env, log, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
        generation,
        owner,
        repo: repoName,
      });

      const statusTarget = { owner, repo: repoName, prNumber: pr.number, headSha: pr.head.sha };
      await postPendingReviewStatus(log, ghToken, statusTarget, userAgent, meta);
      log.info("session.created", { ...meta, session_id: sessionId, action: "review" });

      const prompt = buildCodeReviewPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        headSha: pr.head.sha,
        isDraft: freshness.draft,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
      });

      const messageId = await sendReviewPrompt(
        env,
        log,
        traceId,
        sessionId,
        { content: prompt, authorId: `github:${payload.sender.id}` },
        statusTarget
      );
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "review",
      };
    }
  );
}

export async function handlePullRequestReviewTrigger(
  env: Env,
  log: Logger,
  payload: PullRequestReviewTriggerPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  const userAgent = resolveAppName(env);
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    userAgent,
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });

      // Freshness runs as the last await before claim: any earlier network-bound
      // step (target resolution) widens the window in which a close/draft
      // tombstone or newer push could outrank this snapshot.
      const freshness = await getPullRequestSnapshot(
        ghToken,
        owner,
        repoName,
        pr.number,
        userAgent
      );
      if (!freshness.ok) {
        log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
        return { outcome: "skipped", skip_reason: "freshness_check_failed" };
      }
      if (freshness.headSha !== pr.head.sha || freshness.state !== "open" || freshness.draft) {
        log.debug("handler.stale_head_sha", {
          ...meta,
          current_head_sha: freshness.headSha,
          expected_head_sha: pr.head.sha,
          state: freshness.state,
          draft: freshness.draft,
        });
        return { outcome: "skipped", skip_reason: "stale_head_sha" };
      }

      const generation = await claimReviewGeneration(env, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
      });

      let sessionId: string;
      try {
        sessionId = await createSession(env, traceId, {
          target,
          title: `GitHub: Review PR #${pr.number}`,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          scmLogin: sender.login,
          scmUserId: String(sender.id),
          scmAvatarUrl: sender.avatar_url,
          githubReview: {
            repoId: repo.id,
            prNumber: pr.number,
            generation,
            headSha: pr.head.sha,
            owner,
            repo: repoName,
          },
        });
      } catch (error) {
        if (error instanceof ReviewSupersededError) {
          // A newer trigger already owns the fence; its claim must stand.
          log.info("handler.review_superseded", { ...meta, generation });
          return { outcome: "skipped", skip_reason: "superseded" };
        }
        // The claim bumped the fence but no session will ever carry it. Roll it
        // back so a review still running on the previous generation is not
        // permanently locked out of submitting.
        await releaseReviewGeneration(env, log, traceId, {
          repoId: repo.id,
          prNumber: pr.number,
          generation,
        });
        throw error;
      }

      await sweepStaleReviews(env, log, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
        generation,
        owner,
        repo: repoName,
      });

      const statusTarget = { owner, repo: repoName, prNumber: pr.number, headSha: pr.head.sha };
      await postPendingReviewStatus(log, ghToken, statusTarget, userAgent, meta);
      log.info("session.created", { ...meta, session_id: sessionId, action: "auto_review" });

      const prompt = buildCodeReviewPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        headSha: pr.head.sha,
        isDraft: freshness.draft,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
        isSelfReview: pr.user.login.toLowerCase() === env.GITHUB_BOT_USERNAME.toLowerCase(),
      });

      const messageId = await sendReviewPrompt(
        env,
        log,
        traceId,
        sessionId,
        { content: prompt, authorId: `github:${sender.id}` },
        statusTarget
      );
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "auto_review",
      };
    }
  );
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const commentBody = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, traceId, {
        target,
        title: `GitHub: PR #${issue.number} comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      log.info("session.created", { ...meta, session_id: sessionId, action: "comment" });

      const prompt = buildCommentActionPrompt({
        owner,
        repo: repoName,
        number: issue.number,
        title: issue.title,
        commentBody,
        commenter: sender.login,
        isPublic: !repo.private,
        commentActionInstructions: config.commentActionInstructions,
      });

      const messageId = await sendPrompt(env, traceId, sessionId, {
        content: prompt,
        authorId: `github:${sender.id}`,
      });
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "comment",
      };
    }
  );
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const commentBody = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/pulls/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, traceId, {
        target,
        title: `GitHub: PR #${pr.number} review comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

      const prompt = buildCommentActionPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
        head: pr.head.ref,
        commentBody,
        commenter: sender.login,
        isPublic: !repo.private,
        filePath: comment.path,
        diffHunk: comment.diff_hunk,
        commentId: comment.id,
        commentActionInstructions: config.commentActionInstructions,
      });

      const messageId = await sendPrompt(env, traceId, sessionId, {
        content: prompt,
        authorId: `github:${sender.id}`,
      });
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "review_comment",
      };
    }
  );
}
