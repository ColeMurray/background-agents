import { mutate } from "swr";
import { browserApiFetch } from "./browser-api-fetch";
import { applySessionUnread, isSessionListKey, type SessionListResponse } from "./session-list";
import {
  sessionReadStateResultSchema,
  type SessionReadStateAction,
  type SessionReadStateResult,
} from "@open-inspect/shared";

export type TerminalOutcomeAcknowledgement = "acknowledged" | "retry" | "not_applicable";

export class SessionReadStateRequestError extends Error {
  constructor(readonly status: number) {
    super(`Failed to update read state: ${status}`);
    this.name = "SessionReadStateRequestError";
  }
}

async function patchSessionReadState(
  sessionId: string,
  action: SessionReadStateAction
): Promise<SessionReadStateResult> {
  const response = await browserApiFetch(`/api/sessions/${sessionId}/read-state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new SessionReadStateRequestError(response.status);
  return sessionReadStateResultSchema.parse(await response.json());
}

export function classifyTerminalAcknowledgement(
  result: SessionReadStateResult,
  observedAttentionId: string
): TerminalOutcomeAcknowledgement {
  if (result.accepted) return "acknowledged";
  // A different cursor may only reflect projection lag, so keep the bounded retry alive.
  return result.attentionId === observedAttentionId ? "not_applicable" : "retry";
}

export function acknowledgeSessionAttention(
  sessionId: string,
  observedAttentionId: string
): Promise<SessionReadStateResult> {
  return patchSessionReadState(sessionId, { action: "acknowledge", observedAttentionId });
}

export function markSessionRead(sessionId: string): Promise<SessionReadStateResult> {
  return patchSessionReadState(sessionId, { action: "mark_read" });
}

export function reconcileSessionUnread(result: SessionReadStateResult): Promise<unknown> {
  return mutate<SessionListResponse>(
    isSessionListKey,
    (current) => applySessionUnread(current, result.sessionId, result.unread, result.attentionId),
    { populateCache: true, revalidate: false }
  );
}
