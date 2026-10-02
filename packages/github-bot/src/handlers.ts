import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { resolveAppName } from "@open-inspect/shared/app-name";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken, postReaction, checkSenderPermission } from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { launchSession, type SessionLaunchResult } from "./session-launch";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import { containsBotMention, stripBotMention } from "./github-mention";

export type HandlerResult = SessionLaunchResult | { outcome: "skipped"; skip_reason: string };

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.requested_reviewer?.login === botUsername;
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
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta,
    () =>
      launchSession(env, log, {
        owner,
        repoName,
        sender,
        config,
        ghToken,
        traceId,
        pullNumber: pr.number,
        title: `GitHub: Review PR #${pr.number}`,
        action: "review",
        buildPrompt: () =>
          buildCodeReviewPrompt({
            owner,
            repo: repoName,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            author: pr.user.login,
            base: pr.base.ref,
            head: pr.head.ref,
            isPublic: !repo.private,
            codeReviewInstructions: config.codeReviewInstructions,
          }),
      })
  );
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
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
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta,
    () =>
      launchSession(env, log, {
        owner,
        repoName,
        sender,
        config,
        ghToken,
        traceId,
        pullNumber: pr.number,
        title: `GitHub: Review PR #${pr.number}`,
        action: "auto_review",
        buildPrompt: () =>
          buildCodeReviewPrompt({
            owner,
            repo: repoName,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            author: pr.user.login,
            base: pr.base.ref,
            head: pr.head.ref,
            isPublic: !repo.private,
            codeReviewInstructions: config.codeReviewInstructions,
            isSelfReview: pr.user.login.toLowerCase() === env.GITHUB_BOT_USERNAME.toLowerCase(),
          }),
      })
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
    () =>
      launchSession(env, log, {
        owner,
        repoName,
        sender,
        config,
        ghToken,
        traceId,
        pullNumber: issue.number,
        title: `GitHub: PR #${issue.number} comment`,
        action: "comment",
        buildPrompt: () =>
          buildCommentActionPrompt({
            owner,
            repo: repoName,
            number: issue.number,
            title: issue.title,
            commentBody,
            commenter: sender.login,
            isPublic: !repo.private,
            commentActionInstructions: config.commentActionInstructions,
          }),
      })
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
    () =>
      launchSession(env, log, {
        owner,
        repoName,
        sender,
        config,
        ghToken,
        traceId,
        pullNumber: pr.number,
        title: `GitHub: PR #${pr.number} review comment`,
        action: "review_comment",
        buildPrompt: () =>
          buildCommentActionPrompt({
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
          }),
      })
  );
}
