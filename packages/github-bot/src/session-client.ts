import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
} from "@open-inspect/shared/types/session-api";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";
import type { SessionTargetFields } from "./session-target";

const sessionCreationErrorSchema = z.object({ code: z.string() });
const promptErrorSchema = z.object({ code: z.string().optional() });

/** Prompt POST failed. `code` is the control plane's machine-readable reason. */
export class PromptDeliveryError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, body: string) {
    super(`Prompt delivery failed: ${status} ${body}`);
    this.name = "PromptDeliveryError";
    this.status = status;
    this.code = readPromptErrorCode(body);
  }
}

function readPromptErrorCode(body: string): string | undefined {
  try {
    const parsed = promptErrorSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    return undefined;
  }
}

export type SessionCreationResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; code: string | undefined; body: string };

export async function createSession(
  env: Env,
  traceId: string,
  params: {
    target: SessionTargetFields;
    teamId: string | null;
    title: string;
    model: string;
    harness: HarnessId;
    reasoningEffort?: string | null;
    scmLogin: string;
    scmUserId: string;
    scmAvatarUrl: string;
  }
): Promise<SessionCreationResult> {
  const body: Record<string, unknown> = {
    ...params.target,
    teamId: params.teamId,
    title: params.title,
    model: params.model,
    harness: params.harness,
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
    return {
      ok: false,
      status: response.status,
      code: parsed.success ? parsed.data.code : undefined,
      body: await response.text(),
    };
  }
  const result = createSessionResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Session creation failed: invalid response");
  }
  return { ok: true, sessionId: result.data.sessionId };
}

export async function sendPrompt(
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
    throw new PromptDeliveryError(response.status, body);
  }
  const result = sendPromptResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  return result.data.messageId;
}
