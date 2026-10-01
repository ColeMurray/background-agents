import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CreateSessionResponse,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import { createLogger } from "../logger";
import { buildSessionTargetRequestFields, targetId, type SlackSessionTarget } from "../targets";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";

const log = createLogger("handler");

interface CreateSessionOptions {
  target: SlackSessionTarget;
  teamId?: string | null;
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
  | { ok: false; reason: "stale" | "forbidden" | "transient" };

export interface CreateSessionFailure {
  error: { status: number; code?: string; reasonCode?: string; repository?: string };
}

export async function createSession(
  env: ControlPlaneEnv,
  options: CreateSessionOptions
): Promise<CreateSessionResponse | CreateSessionFailure | null> {
  const {
    target,
    teamId,
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
    const url = "https://internal/sessions";
    const body = JSON.stringify({
      ...buildSessionTargetRequestFields(target, branch),
      teamId,
      model,
      reasoningEffort,
      actorDisplayName,
      actorEmail,
    });
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "POST",
        url,
        body,
        actor: slackUserId ? `slack:${slackUserId}` : undefined,
        traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      log.error("control_plane.create_session", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      const details: unknown = await response.json().catch(() => null);
      const body =
        details && typeof details === "object" ? (details as Record<string, unknown>) : {};
      return {
        error: {
          status: response.status,
          code: typeof body.code === "string" ? body.code : undefined,
          reasonCode: typeof body.reason_code === "string" ? body.reason_code : undefined,
          repository: typeof body.repository === "string" ? body.repository : undefined,
        },
      };
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
  model?: string;
  reasoningEffort?: string;
  callbackContext?: CallbackContext;
  attachments?: SessionAttachmentReference[];
  traceId?: string;
}

export async function sendPrompt(
  env: ControlPlaneEnv,
  options: SendPromptOptions
): Promise<SendPromptResult> {
  const {
    sessionId,
    content,
    authorId,
    model,
    reasoningEffort,
    callbackContext,
    attachments,
    traceId,
  } = options;
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, source: "slack" };
  try {
    const url = `https://internal/sessions/${sessionId}/prompt`;
    const body = JSON.stringify({
      content,
      source: "slack",
      model,
      reasoningEffort,
      callbackContext,
      ...(attachments?.length ? { attachments } : {}),
    });
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "POST",
        url,
        body,
        actor: authorId.startsWith("slack:") ? authorId : undefined,
        traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      log.error("control_plane.send_prompt", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return {
        ok: false,
        reason:
          response.status === 404 ? "stale" : response.status === 403 ? "forbidden" : "transient",
      };
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
