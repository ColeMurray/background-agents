import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken, postReaction } from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { generateInternalToken } from "./utils/internal";

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
  params: { repoOwner: string; repoName: string; title: string; model: string }
): Promise<string> {
  const response = await controlPlane.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(params),
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

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<void> {
  const { pull_request: pr, repository: repo, requested_reviewer } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return;
  }

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  const meta = { trace_id: traceId, repo: `${owner}/${repoName}`, pull_number: pr.number };
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
    model: env.DEFAULT_MODEL,
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
  const { pull_request: pr, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return;
  }

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return;
  }

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  const meta = { trace_id: traceId, repo: `${owner}/${repoName}`, pull_number: pr.number };
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
    model: env.DEFAULT_MODEL,
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

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<void> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;

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

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  const meta = { trace_id: traceId, repo: `${owner}/${repoName}`, pull_number: issue.number };
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
    model: env.DEFAULT_MODEL,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "comment" });

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title,
    commentBody,
    commenter: sender.login,
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

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  const meta = { trace_id: traceId, repo: `${owner}/${repoName}`, pull_number: pr.number };
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
    model: env.DEFAULT_MODEL,
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
