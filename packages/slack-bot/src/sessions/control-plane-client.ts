import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CreateSessionResponse,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { listArtifactsResponseSchema } from "@open-inspect/shared/types/artifacts";
import { ProtectedReadError } from "@open-inspect/shared/completion/extractor";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import { createLogger } from "../logger";
import { buildSessionTargetRequestFields, targetId, type SlackSessionTarget } from "../targets";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";

const log = createLogger("handler");

const HARNESS_MODEL_INCOMPATIBLE_FALLBACK = "This thread's harness can't run that model.";

interface CreateSessionOptions {
  target: SlackSessionTarget;
  teamId?: string | null;
  /** The workspace's Slack harness setting, logged beside the harness the session runs on. */
  configuredHarness: HarnessId;
  harness: HarnessId;
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
  | { ok: false; reason: "stale" | "forbidden" | "transient" | "channel_scope_denied" }
  /** The session's harness cannot run the prompt's model; `message` is the reply to post. */
  | { ok: false; reason: "harness_model_incompatible"; message: string };

export interface CreateSessionFailure {
  error: { status: number; code?: string; reasonCode?: string; repository?: string };
}

export async function checkPublicationAccess(
  env: ControlPlaneEnv,
  sessionId: string,
  channel: string,
  traceId?: string
): Promise<"allowed" | "denied" | "unavailable"> {
  const url = new URL(`https://internal/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  url.searchParams.set("channel", `slack:${channel}`);
  url.searchParams.set("purpose", "slack-post");
  try {
    const response = await signedControlPlaneFetch(
      env,
      { method: "GET", url: url.toString(), traceId },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    if (response.status === 403 || response.status === 404) return "denied";
    if (!response.ok) return "unavailable";
    return listArtifactsResponseSchema.safeParse(await response.json()).success
      ? "allowed"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function requirePublicationAccess(
  env: ControlPlaneEnv,
  sessionId: string,
  channel: string,
  traceId?: string
): Promise<void> {
  const access = await checkPublicationAccess(env, sessionId, channel, traceId);
  if (access !== "allowed")
    throw new ProtectedReadError(
      `Control plane publication access ${access}`,
      access === "denied" ? 403 : undefined
    );
}

export async function createSession(
  env: ControlPlaneEnv,
  options: CreateSessionOptions
): Promise<CreateSessionResponse | CreateSessionFailure | null> {
  const {
    target,
    teamId,
    configuredHarness,
    harness,
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
    configured_harness: configuredHarness,
    harness,
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
      harness,
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
  channel: string;
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
    channel,
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
    const url = new URL(`https://internal/sessions/${sessionId}/prompt`);
    url.searchParams.set("channel", `slack:${channel}`);
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
        url: url.toString(),
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
      const details: unknown = await response.json().catch(() => null);
      const body =
        details && typeof details === "object" ? (details as Record<string, unknown>) : {};
      if (body.code === "slack_channel_scope_denied") {
        return { ok: false, reason: "channel_scope_denied" };
      }
      if (response.status === 400 && body.code === "HARNESS_MODEL_INCOMPATIBLE") {
        return {
          ok: false,
          reason: "harness_model_incompatible",
          message:
            typeof body.error === "string" ? body.error : HARNESS_MODEL_INCOMPATIBLE_FALLBACK,
        };
      }
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
