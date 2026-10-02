import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
} from "@open-inspect/shared/types/session-api";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postReaction,
  postIssueComment,
  checkSenderPermission,
} from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { resolveSessionTarget, type SessionTargetFields } from "./session-target";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import { containsBotMention, stripBotMention } from "./github-mention";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; message_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

const githubRouteResponseSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("workspace"), teamId: z.null() }),
  z.object({ via: z.literal("sender_membership"), teamId: z.string().min(1) }),
  z.object({ via: z.literal("pull_request_session"), teamId: z.string().min(1).nullable() }),
]);

const sessionCreationErrorSchema = z.object({
  code: z.string(),
  repository: z.string().min(1).optional(),
});

async function resolveGitHubRoute(
  env: Env,
  log: Logger,
  traceId: string,
  params: { repositoryId: number; pullNumber?: number; senderId?: number }
): Promise<z.infer<typeof githubRouteResponseSchema> | null> {
  const query = new URLSearchParams({ repositoryId: String(params.repositoryId) });
  if (params.pullNumber !== undefined) query.set("pullNumber", String(params.pullNumber));
  if (params.senderId !== undefined) query.set("sender", `github:${params.senderId}`);
  try {
    const url = `https://internal/github/route?${query}`;
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });
    if (!response.ok) {
      log.warn("route.lookup_failed", { trace_id: traceId, status: response.status });
      return null;
    }
    const parsed = githubRouteResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log.warn("route.invalid_response", { trace_id: traceId });
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn("route.lookup_failed", {
      trace_id: traceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.requested_reviewer?.login === botUsername;
}

async function createSession(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    target: SessionTargetFields;
    teamId: string | null;
    owner: string;
    repoName: string;
    pullNumber: number;
    ghToken: string;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    scmLogin: string;
    scmUserId: string;
    scmAvatarUrl: string;
  }
): Promise<string | Extract<HandlerResult, { outcome: "skipped" }>> {
  const body: Record<string, unknown> = {
    ...params.target,
    teamId: params.teamId,
    title: params.title,
    model: params.model,
    scmLogin: params.scmLogin,
    scmAvatarUrl: params.scmAvatarUrl,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
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
    const parsed = sessionCreationErrorSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null)
    );
    if (
      parsed.success &&
      ((response.status === 403 && parsed.data.code === "not_member") ||
        (response.status === 409 && parsed.data.code === "target_team_missing_grant"))
    ) {
      const { code, repository } = parsed.data;
      const repo = repository ?? `${params.owner}/${params.repoName}`;
      const comment =
        code === "not_member"
          ? "I couldn't start a session because you are not a member of the target team. Ask a team lead to add you, then try again."
          : `I couldn't start a session because the target team does not have a repository grant for \`${repo}\`. Ask a team lead or workspace administrator to grant access, then try again.`;
      const repositoryPath = encodeRepositoryPathSegments({
        repoOwner: params.owner,
        repoName: params.repoName,
      });
      const posted = await postIssueComment(
        params.ghToken,
        `https://api.github.com/repos/${repositoryPath}/issues/${params.pullNumber}/comments`,
        comment,
        resolveAppName(env)
      );
      if (!posted) {
        log.warn("session.refusal_comment_failed", { trace_id: traceId, repo, code });
        throw new Error(`Session refusal comment failed: ${code}`);
      }
      return { outcome: "skipped", skip_reason: code };
    }
    const body = await response.text();
    throw new Error(`Session creation failed: ${response.status} ${body}`);
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
  params: { content: string; authorId: string }
): Promise<string> {
  const url = `https://internal/sessions/${sessionId}/prompt`;
  const bodyText = JSON.stringify({ content: params.content, source: "github" });
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
  // The allowlist gates first; routed-team membership is rechecked on session creation.
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
    async () => {
      const route = await resolveGitHubRoute(env, log, traceId, {
        repositoryId: repo.id,
        pullNumber: pr.number,
        senderId: sender.id,
      });
      if (!route) return { outcome: "skipped", skip_reason: "route_lookup_failed" };
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        teamId: route.teamId,
        senderId: sender.id,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, log, traceId, {
        target,
        teamId: route.teamId,
        owner,
        repoName,
        pullNumber: pr.number,
        ghToken,
        title: `GitHub: Review PR #${pr.number}`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      if (typeof sessionId !== "string") return sessionId;
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
        codeReviewInstructions: config.codeReviewInstructions,
      });

      const messageId = await sendPrompt(env, traceId, sessionId, {
        content: prompt,
        authorId: `github:${payload.sender.id}`,
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
        handler_action: "review",
      };
    }
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
    async () => {
      const route = await resolveGitHubRoute(env, log, traceId, { repositoryId: repo.id });
      if (!route) return { outcome: "skipped", skip_reason: "route_lookup_failed" };
      // Deprecated auto-review always stays workspace-level, regardless of sender or PR ownership.
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        teamId: null,
        senderId: sender.id,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, log, traceId, {
        target,
        teamId: null,
        owner,
        repoName,
        pullNumber: pr.number,
        ghToken,
        title: `GitHub: Review PR #${pr.number}`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      if (typeof sessionId !== "string") return sessionId;
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
        codeReviewInstructions: config.codeReviewInstructions,
        isSelfReview: pr.user.login.toLowerCase() === env.GITHUB_BOT_USERNAME.toLowerCase(),
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
      const route = await resolveGitHubRoute(env, log, traceId, {
        repositoryId: repo.id,
        pullNumber: issue.number,
        senderId: sender.id,
      });
      if (!route) return { outcome: "skipped", skip_reason: "route_lookup_failed" };
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        teamId: route.teamId,
        senderId: sender.id,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, log, traceId, {
        target,
        teamId: route.teamId,
        owner,
        repoName,
        pullNumber: issue.number,
        ghToken,
        title: `GitHub: PR #${issue.number} comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      if (typeof sessionId !== "string") return sessionId;
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
      const route = await resolveGitHubRoute(env, log, traceId, {
        repositoryId: repo.id,
        pullNumber: pr.number,
        senderId: sender.id,
      });
      if (!route) return { outcome: "skipped", skip_reason: "route_lookup_failed" };
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        teamId: route.teamId,
        senderId: sender.id,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, log, traceId, {
        target,
        teamId: route.teamId,
        owner,
        repoName,
        pullNumber: pr.number,
        ghToken,
        title: `GitHub: PR #${pr.number} review comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      if (typeof sessionId !== "string") return sessionId;
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
