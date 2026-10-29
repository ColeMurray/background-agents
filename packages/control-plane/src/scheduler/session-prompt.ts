import type { FirstPromptInput } from "./launch-contracts";
import type {
  AutomationCallbackContext,
  SlackCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import type { CorrelationContext } from "../logger";
import { promptRequestLookupSchema, SessionInternalPaths } from "../session/contracts";
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
  /** The session already queued the prompt its clientRequestId names. */
  | { kind: "duplicate" }
  /** The session already queued a different prompt under this clientRequestId. */
  | { kind: "request_id_taken" }
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
  if (response.ok) {
    const accepted = sendPromptResponseSchema.safeParse(await response.json().catch(() => null));
    return accepted.success && accepted.data.deduplicated
      ? { kind: "duplicate" }
      : { kind: "queued" };
  }

  const code = await rejectionCode(response);
  if (response.status === 409 && code === "PROMPT_REQUEST_CONFLICT") {
    return { kind: "request_id_taken" };
  }
  return { kind: "rejected", status: response.status, code };
}

/** Whether the session queued a prompt under this clientRequestId; throws when it cannot say. */
export async function isSessionPromptRequestQueued(
  env: Env,
  sessionId: string,
  clientRequestId: string,
  ctx: CorrelationContext
): Promise<boolean> {
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.promptRequest,
    { method: "GET" },
    `?clientRequestId=${encodeURIComponent(clientRequestId)}`
  );
  if (!response.ok) throw new Error(`Prompt request lookup failed with status ${response.status}`);
  return promptRequestLookupSchema.parse(await response.json()).queued;
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

/** Queue an automation's first prompt under its stable run request ID. */
export async function enqueueAutomationFirstPrompt(
  env: Env,
  input: FirstPromptInput
): Promise<void> {
  const { sessionId, automation, runId, executionPrincipal, instructionsOverride } = input;
  const callbackContext: AutomationCallbackContext = {
    source: "automation",
    automationId: automation.id,
    runId,
    automationName: automation.name,
  };

  const outcome = await enqueueSessionPrompt(
    env,
    sessionId,
    {
      content: instructionsOverride ?? automation.instructions,
      authorId: executionPrincipal.participantUserId,
      canonicalUserId: executionPrincipal.platformUserId,
      source: "automation",
      callbackContext,
      clientRequestId: firstPromptRequestId(runId),
    },
    { trace_id: `automation:${automation.id}`, request_id: runId }
  );
  if (outcome.kind === "rejected") {
    throw new Error(`Prompt enqueue failed with status ${outcome.status}`);
  }
  if (outcome.kind === "request_id_taken") {
    throw new Error("Prompt enqueue was refused: its request id names another prompt");
  }
  // A duplicate means the session already queued this run's first prompt.
}

/**
 * The clientRequestId of a run's own first prompt: the session can say whether it took
 * it, independently of the launching worker recording that.
 */
export function firstPromptRequestId(runId: string): string {
  return `automation-run:${runId}`;
}
