import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { EmailCallbackContext } from "@open-inspect/shared";
import type { EmailRoute, EmailThreadSession, Env, NormalizedEmailMessage } from "./types";

async function authHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}

export async function createSession(params: {
  env: Env;
  route: EmailRoute;
  title: string;
  actorEmail: string;
  traceId?: string;
}): Promise<string> {
  const { env, route, title, actorEmail, traceId } = params;
  const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers: await authHeaders(env, traceId),
    body: JSON.stringify({
      repoOwner: route.repoOwner,
      repoName: route.repoName,
      branch: route.branch,
      title,
      model: route.model || env.DEFAULT_MODEL,
      reasoningEffort: route.reasoningEffort || env.DEFAULT_REASONING_EFFORT,
      spawnSource: "email-bot",
      actorUserId: `email:${actorEmail}`,
      actorDisplayName: actorEmail,
      actorEmail,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Control-plane create session failed: ${response.status} ${body.slice(0, 500)}`
    );
  }

  const result = (await response.json()) as { sessionId: string };
  return result.sessionId;
}

export async function sendPrompt(params: {
  env: Env;
  sessionId: string;
  route: EmailRoute;
  message: NormalizedEmailMessage;
  requestId: string;
  content: string;
  traceId?: string;
}): Promise<string> {
  const { env, sessionId, route, message, requestId, content, traceId } = params;
  const callbackContext: EmailCallbackContext = {
    source: "email",
    inboxId: message.inboxId,
    threadId: message.threadId,
    messageId: message.messageId,
    requestId,
    routeId: route.id,
    replyTo: message.senderEmail,
    subject: message.subject,
    repoFullName: `${route.repoOwner}/${route.repoName}`,
    model: route.model || env.DEFAULT_MODEL,
    reasoningEffort: route.reasoningEffort || env.DEFAULT_REASONING_EFFORT,
  };

  const response = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: await authHeaders(env, traceId),
    body: JSON.stringify({
      content,
      authorId: `email:${message.senderEmail}`,
      authorDisplayName: message.from,
      authorEmail: message.senderEmail,
      source: "email",
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      attachments: message.attachments.map((attachment, index) => ({
        type: "file",
        name:
          attachment && typeof attachment === "object" && "filename" in attachment
            ? String((attachment as Record<string, unknown>).filename)
            : `attachment-${index + 1}`,
        content: JSON.stringify(attachment),
      })),
      callbackContext,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Control-plane prompt failed: ${response.status} ${body.slice(0, 500)}`);
  }

  const result = (await response.json()) as { messageId: string };
  return result.messageId;
}

export function makeThreadSession(params: {
  sessionId: string;
  route: EmailRoute;
  requestId: string;
  env: Env;
}): EmailThreadSession {
  const now = Date.now();
  return {
    sessionId: params.sessionId,
    routeId: params.route.id,
    requestId: params.requestId,
    repoFullName: `${params.route.repoOwner}/${params.route.repoName}`,
    model: params.route.model || params.env.DEFAULT_MODEL,
    reasoningEffort: params.route.reasoningEffort || params.env.DEFAULT_REASONING_EFFORT,
    createdAt: now,
    updatedAt: now,
  };
}
