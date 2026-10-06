import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env, ReviewRequestedPayload } from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postReaction,
  postIssueComment,
  checkSenderPermission,
} from "./github-auth";
import { resolveSessionTarget } from "./session-target";
import { createSession, sendPrompt } from "./session-client";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { resolveModelSelection } from "./model-selection";
import type { ParseInlinePromptFlagsResult } from "@open-inspect/shared/inline-prompt-flags";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; message_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

const githubRouteResponseSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("workspace"), teamId: z.null() }),
  z.object({ via: z.literal("sender_membership"), teamId: z.string().min(1) }),
  z.object({ via: z.literal("pull_request_session"), teamId: z.string().min(1).nullable() }),
]);

async function resolveGitHubRoute(
  env: Env,
  log: Logger,
  traceId: string,
  params: { repositoryId: number; pullNumber: number; senderId: number }
): Promise<z.infer<typeof githubRouteResponseSchema>> {
  const query = new URLSearchParams({
    repositoryId: String(params.repositoryId),
    pullNumber: String(params.pullNumber),
    sender: `github:${params.senderId}`,
  });
  try {
    const url = `https://internal/github/route?${query}`;
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });
    if (!response.ok) {
      throw new Error(`GitHub routing lookup failed: ${response.status}`);
    }
    const parsed = githubRouteResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("GitHub routing lookup failed: invalid response");
    }
    return parsed.data;
  } catch (err) {
    log.warn("route.lookup_failed", {
      trace_id: traceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }
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

export async function startSession(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    repository: ReviewRequestedPayload["repository"];
    sender: ReviewRequestedPayload["sender"];
    pullNumber: number;
    title: string;
    action: "review" | "auto_review" | "comment" | "review_comment";
    reactionPath: string;
    /** `!model` / `!reasoning` flags parsed from the triggering comment, if any. */
    inlineFlags?: ParseInlinePromptFlagsResult;
    buildPrompt: (config: ResolvedGitHubConfig) => string;
  }
): Promise<HandlerResult> {
  const { repository: repo, sender, pullNumber, action } = params;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }
  if (action === "auto_review" && !config.autoReviewOnOpen) {
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
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const userAgent = resolveAppName(env);
  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pullNumber };

  const modelSelection = await resolveModelSelection(
    env,
    log,
    traceId,
    { model: config.model, harness: config.harness, reasoningEffort: config.reasoningEffort },
    params.inlineFlags
  );
  if (!modelSelection.ok) {
    const posted = await postIssueComment(
      ghToken,
      `https://api.github.com/repos/${repositoryPath}/issues/${pullNumber}/comments`,
      modelSelection.message,
      userAgent
    );
    if (!posted) {
      log.warn("session.refusal_comment_failed", { ...meta, code: modelSelection.reason });
      throw new Error(`Session refusal comment failed: ${modelSelection.reason}`);
    }
    log.info("handler.inline_flags_rejected", { ...meta, reason: modelSelection.reason });
    return { outcome: "skipped", skip_reason: modelSelection.reason };
  }
  const { selection } = modelSelection;

  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/${params.reactionPath}/reactions`,
    userAgent,
    meta,
    async () => {
      // Deprecated auto-review is always workspace-level and never needs a route lookup.
      const teamId =
        action === "auto_review"
          ? null
          : (
              await resolveGitHubRoute(env, log, traceId, {
                repositoryId: repo.id,
                pullNumber,
                senderId: sender.id,
              })
            ).teamId;
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        teamId,
        senderId: sender.id,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const creation = await createSession(env, traceId, {
        target,
        teamId,
        title: params.title,
        model: selection.model,
        harness: selection.harness,
        reasoningEffort: selection.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      if (!creation.ok) {
        const { status, code, body } = creation;
        if (
          (status === 403 && code === "not_member") ||
          (status === 409 && (code === "target_team_missing_grant" || code === "team_archived"))
        ) {
          // A PR comment must not disclose secondary repositories from the environment.
          const triggerRepo = `${owner}/${repoName}`;
          const comment = {
            not_member:
              "I couldn't start a session because you are not a member of the target team. Ask a team lead to add you, then try again.",
            target_team_missing_grant: `I couldn't start a session because the target team is missing a required repository grant to work on \`${triggerRepo}\`. Ask a team lead or workspace administrator to review the team's repository and environment grants, then try again.`,
            team_archived:
              "I couldn't start a session because the target team is archived. Ask a workspace administrator to restore the team, then try again.",
          }[code];
          const posted = await postIssueComment(
            ghToken,
            `https://api.github.com/repos/${repositoryPath}/issues/${pullNumber}/comments`,
            comment,
            userAgent
          );
          if (!posted) {
            log.warn("session.refusal_comment_failed", {
              trace_id: traceId,
              repo: triggerRepo,
              code,
            });
            throw new Error(`Session refusal comment failed: ${code}`);
          }
          return { outcome: "skipped", skip_reason: code };
        }
        throw new Error(`Session creation failed: ${status} ${body}`);
      }
      const { sessionId } = creation;
      log.info("session.created", {
        ...meta,
        session_id: sessionId,
        action,
        model: selection.model,
        reasoning_effort: selection.reasoningEffort,
        inline_model_override: modelSelection.overridden,
      });

      const prompt = params.buildPrompt(config);
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
        handler_action: action,
      };
    }
  );
}
