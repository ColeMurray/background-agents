import { mutate } from "swr";
import { browserApiFetch } from "./browser-api-fetch";
import { applySessionReadState, isSessionListKey, type SessionListResponse } from "./session-list";
import {
  sessionReadResultSchema,
  type SessionReadAction,
  type SessionReadResult,
  type SessionReadState,
} from "@open-inspect/shared/types/sessions";

export type SessionReadAttemptDisposition = "complete" | "retry" | "permanent_failure";

export class SessionReadRequestError extends Error {
  constructor(readonly status: number) {
    super(`Failed to update session read state: ${status}`);
    this.name = "SessionReadRequestError";
  }
}

async function patchSessionReadState(
  sessionId: string,
  action: SessionReadAction
): Promise<SessionReadResult> {
  const response = await browserApiFetch(`/api/sessions/${sessionId}/read-state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new SessionReadRequestError(response.status);
  return sessionReadResultSchema.parse(await response.json());
}

export function classifySessionReadAttempt(
  result: SessionReadResult
): SessionReadAttemptDisposition {
  return result.outcome === "marked_read" || result.outcome === "already_read"
    ? "complete"
    : "retry";
}

export function markMessageRead(sessionId: string, messageId: string): Promise<SessionReadResult> {
  return patchSessionReadState(sessionId, {
    action: "mark_message_read",
    messageId,
  });
}

export function markLatestMessageRead(sessionId: string): Promise<SessionReadResult> {
  return patchSessionReadState(sessionId, {
    action: "mark_latest_message_read",
  });
}

export function readStateFromResult(result: SessionReadResult): SessionReadState {
  return result.latestMessageId === null
    ? {
        latestMessageId: null,
        unread: false,
      }
    : {
        latestMessageId: result.latestMessageId,
        unread: result.unread,
      };
}

export function reconcileSessionReadState(result: SessionReadResult): Promise<unknown> {
  const readState = readStateFromResult(result);
  return mutate<SessionListResponse>(
    isSessionListKey,
    (current) => applySessionReadState(current, result.sessionId, readState),
    { populateCache: true, revalidate: false }
  );
}
