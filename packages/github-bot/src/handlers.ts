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
import { generateInternalToken } from "./utils/internal";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";

async function getAuthHeaders(env: Env, traceId: string): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-trace-id": traceId,
  };
}

async function createSession(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  params: {
    repoOwner: string;
    repoName: string;
    title: string;
    model: string;
    reasoningEffort?: string | null;
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    title: params.title,
    model: params.model,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  const response = await controlPlane.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session creation failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { sessionId: string };
  return result.sessionId;
}

async function sendPrompt(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  sessionId: string,
  params: { content: string; authorId: string }
): Promise<string> {
  const response = await controlPlane.fetch(`https://internal/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...params, source: "github" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { messageId: string };
  return result.messageId;
}

function stripMention(body: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`@${escaped}`, "gi"), "").trim();
}

function fireAndForgetReaction(
  log: Logger,
  token: string,
  url: string,
  meta: Record<string, unknown>
): void {
  postReaction(token, url, "eyes").then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
}

type CallerGatingResult =
  | { allowed: true; ghToken: string; headers: Record<string, string> }
  | { allowed: false };

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
      return { allowed: false };
    }
  }

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin
    );
    if (!hasPermission) {
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        { trace_id: traceId, sender: senderLogin, repo: repoFullName }
      );
      return { allowed: false };
    }
  }

  return { allowed: true, ghToken, headers };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<void> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return;
  }

  const config = await getGitHubConfig(env, repoFullName);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return;
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
  if (!gating.allowed) return;
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
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
    isPublic: !repo.private,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${payload.sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<void> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return;
  }

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return;
  }

  const config = await getGitHubConfig(env, repoFullName);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return;
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return;
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
  if (!gating.allowed) return;
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
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
    isPublic: !repo.private,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<void> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return;
  }

  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return;
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return;
  }

  const config = await getGitHubConfig(env, repoFullName);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return;
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
  if (!gating.allowed) return;
  const { ghToken, headers } = gating;

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${issue.number} comment`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
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
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<void> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return;
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return;
  }

  const config = await getGitHubConfig(env, repoFullName);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return;
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
  if (!gating.allowed) return;
  const { ghToken, headers } = gating;

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${comment.id}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${pr.number} review comment`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
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
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });
}
