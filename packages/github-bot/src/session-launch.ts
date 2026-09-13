import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CreateSessionInput,
  type SendPromptRequest,
} from "@open-inspect/shared/types/session-api";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Logger } from "./logger";
import { resolveSessionTarget } from "./session-target";
import type { Env } from "./types";
import type { ResolvedGitHubConfig } from "./utils/integration-config";

export type SessionLaunchResult = {
  outcome: "processed";
  session_id: string;
  message_id: string;
  handler_action: string;
};

export async function launchSession(
  env: Env,
  log: Logger,
  params: {
    owner: string;
    repoName: string;
    sender: { login: string; id: number; avatar_url: string };
    config: ResolvedGitHubConfig;
    ghToken: string;
    traceId: string;
    pullNumber: number;
    title: string;
    action: string;
    buildPrompt: () => string;
  }
): Promise<SessionLaunchResult> {
  const {
    owner,
    repoName,
    sender,
    config,
    ghToken,
    traceId,
    pullNumber,
    title,
    action,
    buildPrompt,
  } = params;
  const meta = {
    trace_id: traceId,
    repo: `${owner}/${repoName}`.toLowerCase(),
    pull_number: pullNumber,
  };
  const target = await resolveSessionTarget(env, log, {
    owner,
    repoName,
    senderLogin: sender.login,
    config,
    ghToken,
    traceId,
  });
  const actor = `github:${sender.id}`;
  const body = {
    ...target,
    title,
    model: config.model,
    scmLogin: sender.login,
    actorAvatarUrl: sender.avatar_url,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  } satisfies CreateSessionInput;
  const sessionResponse = await signedControlPlaneFetch(env, {
    method: "POST",
    url: "https://internal/sessions",
    body: JSON.stringify(body),
    actor,
    traceId,
  });
  if (!sessionResponse.ok) {
    throw new Error(
      `Session creation failed: ${sessionResponse.status} ${await sessionResponse.text()}`
    );
  }
  const sessionResult = createSessionResponseSchema.safeParse(await sessionResponse.json());
  if (!sessionResult.success) {
    throw new Error("Session creation failed: invalid response");
  }
  const sessionId = sessionResult.data.sessionId;
  log.info("session.created", { ...meta, session_id: sessionId, action });

  const prompt = buildPrompt();
  const promptResponse = await signedControlPlaneFetch(env, {
    method: "POST",
    url: `https://internal/sessions/${sessionId}/prompt`,
    body: JSON.stringify({ content: prompt, source: "github" } satisfies SendPromptRequest),
    actor,
    traceId,
  });
  if (!promptResponse.ok) {
    throw new Error(
      `Prompt delivery failed: ${promptResponse.status} ${await promptResponse.text()}`
    );
  }
  const promptResult = sendPromptResponseSchema.safeParse(await promptResponse.json());
  if (!promptResult.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  const messageId = promptResult.data.messageId;
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
