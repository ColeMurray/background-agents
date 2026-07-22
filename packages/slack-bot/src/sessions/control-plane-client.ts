import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CreateSessionResponse,
  type SendPromptResponse,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { getAuthHeaders } from "../internal-auth";
import { createLogger } from "../logger";
import { buildSessionTargetRequestFields, targetId, type SlackSessionTarget } from "../targets";
import type { CallbackContext, Env } from "../types";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";

const log = createLogger("handler");

interface CreateSessionOptions {
  target: SlackSessionTarget;
  model: string;
  reasoningEffort?: string;
  branch?: string;
  traceId?: string;
  slackUserId?: string;
  actorDisplayName?: string;
  actorEmail?: string;
}

export type SendPromptResult =
  | { ok: true; data: SendPromptResponse }
  | { ok: false; reason: "stale" | "transient" };

export async function createSession(
  env: Env,
  options: CreateSessionOptions
): Promise<CreateSessionResponse | null> {
  const {
    target,
    model,
    reasoningEffort,
    branch,
    traceId,
    slackUserId,
    actorDisplayName,
    actorEmail,
  } = options;
  const startTime = Date.now();
  const base = {
    trace_id: traceId,
    target_id: targetId(target),
    model,
    reasoning_effort: reasoningEffort,
    branch,
    slack_user_id: slackUserId,
  };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...buildSessionTargetRequestFields(target, branch),
        model,
        reasoningEffort,
        spawnSource: "slack-bot",
        actorUserId: slackUserId,
        actorDisplayName,
        actorEmail,
      }),
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.error("control_plane.create_session", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return null;
    }
    const result = createSessionResponseSchema.safeParse(await response.json());
    if (!result.success) {
      log.error("control_plane.create_session", {
        ...base,
        outcome: "error",
        error: new Error("Invalid control plane create session response"),
        duration_ms: Date.now() - startTime,
      });
      return null;
    }
    log.info("control_plane.create_session", {
      ...base,
      outcome: "success",
      session_id: result.data.sessionId,
      http_status: 200,
      duration_ms: Date.now() - startTime,
    });
    return result.data;
  } catch (e) {
    log.error("control_plane.create_session", {
      ...base,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return null;
  }
}

export interface SendPromptOptions {
  sessionId: string;
  content: string;
  authorId: string;
  callbackContext?: CallbackContext;
  attachments?: SessionAttachmentReference[];
  traceId?: string;
}

export async function sendPrompt(env: Env, options: SendPromptOptions): Promise<SendPromptResult> {
  const { sessionId, content, authorId, callbackContext, attachments, traceId } = options;
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, source: "slack" };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          authorId,
          source: "slack",
          callbackContext,
          ...(attachments?.length ? { attachments } : {}),
        }),
        signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      log.error("control_plane.send_prompt", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return { ok: false, reason: response.status === 404 ? "stale" : "transient" };
    }
    const result = sendPromptResponseSchema.safeParse(await response.json());
    if (!result.success) {
      log.error("control_plane.send_prompt", {
        ...base,
        outcome: "error",
        error: new Error("Invalid control plane send prompt response"),
        duration_ms: Date.now() - startTime,
      });
      return { ok: false, reason: "transient" };
    }
    log.info("control_plane.send_prompt", {
      ...base,
      outcome: "success",
      message_id: result.data.messageId,
      http_status: 200,
      duration_ms: Date.now() - startTime,
    });
    return { ok: true, data: result.data };
  } catch (e) {
    log.error("control_plane.send_prompt", {
      ...base,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return { ok: false, reason: "transient" };
  }
}
