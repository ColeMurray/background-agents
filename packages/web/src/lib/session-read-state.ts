import { mutate } from "swr";
import { browserApiFetch } from "./browser-api-fetch";
import { applySessionUnread, isSessionListKey, type SessionListResponse } from "./session-list";

export interface SessionReadStateResult {
  sessionId: string;
  accepted: boolean;
  unread: boolean;
}

export class SessionReadStateRequestError extends Error {
  constructor(readonly status: number) {
    super(`Failed to update read state: ${status}`);
    this.name = "SessionReadStateRequestError";
  }
}

type SessionReadStateAction =
  | { action: "acknowledge"; observedAttentionId: string }
  | { action: "mark_read" };

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
  return response.json();
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
    (current) => applySessionUnread(current, result.sessionId, result.unread),
    { populateCache: true, revalidate: false }
  );
}
