import type {
  AutomationCallbackContext,
  SlackCallbackContext,
} from "@open-inspect/shared/types/session-api";
import type { CorrelationContext } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";

export type SchedulerPromptRequest = Pick<
  EnqueuePromptRequest,
  "content" | "authorId" | "canonicalUserId" | "source" | "scmEnrichment" | "clientRequestId"
> & {
  callbackContext?: AutomationCallbackContext | SlackCallbackContext;
};

export type SessionPromptOutcome =
  | { kind: "queued" }
  | { kind: "duplicate" }
  | { kind: "rejected"; status: number; code: string | null };

/** Enqueue a prompt onto a session's queue through its runtime's prompt route. */
export function enqueueSessionPrompt(
  env: Env,
  sessionId: string,
  body: SchedulerPromptRequest,
  ctx: CorrelationContext
): Promise<SessionPromptOutcome> {
  return enqueueSerializedSessionPrompt(env, sessionId, JSON.stringify(body), ctx);
}

/** {@link enqueueSessionPrompt} for a request body serialized earlier, e.g. a held prompt. */
export async function enqueueSerializedSessionPrompt(
  env: Env,
  sessionId: string,
  body: string,
  ctx: CorrelationContext
): Promise<SessionPromptOutcome> {
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.prompt,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
  if (response.ok) return { kind: "queued" };

  const code = await rejectionCode(response);
  if (response.status === 409 && code === "PROMPT_REQUEST_CONFLICT") return { kind: "duplicate" };
  return { kind: "rejected", status: response.status, code };
}

async function rejectionCode(response: Response): Promise<string | null> {
  const payload: unknown = await response.json().catch(() => null);
  return payload !== null &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof payload.code === "string"
    ? payload.code
    : null;
}
