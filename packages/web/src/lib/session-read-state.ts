import { browserApiFetch } from "./browser-api-fetch";
import type { SandboxEvent } from "@/types/session";
import {
  sessionReadResultSchema,
  type SessionReadAction,
  type SessionReadResult,
  type SessionReadState,
} from "@open-inspect/shared/types/sessions";

export type SessionReadAttemptDisposition = "complete" | "retry" | "permanent_failure";
export interface SessionReadStateReconciledDetail {
  sessionId: string;
  outcome: SessionReadResult["outcome"];
  readState: SessionReadState;
}
type SessionReadStateReconciler = (
  detail: SessionReadStateReconciledDetail
) => Promise<unknown> | unknown;
const readStateReconcilers = new Set<SessionReadStateReconciler>();

export function subscribeSessionReadStateReconciliation(
  reconcile: SessionReadStateReconciler
): () => void {
  readStateReconcilers.add(reconcile);
  return () => readStateReconcilers.delete(reconcile);
}

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

/** The terminal message a viewer of these events has in front of them. */
export function findLatestTerminalMessageId(events: SandboxEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "execution_complete" && event.messageId) return event.messageId;
  }
  return null;
}

/**
 * Only a missing projection is worth retrying: the message exists on the
 * client, so the server row will catch up. A `not_latest` result means a newer
 * message is on its way to the client, which acknowledges that one instead.
 */
export function classifySessionReadAttempt(
  result: SessionReadResult
): SessionReadAttemptDisposition {
  return result.outcome === "no_terminal_message" ? "retry" : "complete";
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

function readStateFromResult(result: SessionReadResult): SessionReadState {
  return result.latestMessageId === null
    ? {
        latestMessageId: null,
        unread: false,
        version: result.version,
      }
    : {
        latestMessageId: result.latestMessageId,
        unread: result.unread,
        version: result.version,
      };
}

/**
 * Mirrors the projection's order: a higher version wins, and messages that
 * share a version are ordered by ID. For one message, read is final.
 */
export function readStateSupersedes(next: SessionReadState, current: SessionReadState): boolean {
  if (next.version !== current.version) return next.version > current.version;
  if (next.latestMessageId !== current.latestMessageId) {
    return (next.latestMessageId ?? "") > (current.latestMessageId ?? "");
  }
  return !(current.unread === false && next.unread);
}

export function applySessionReadStateToItem<T extends { id: string; readState?: SessionReadState }>(
  session: T,
  sessionId: string,
  readState: SessionReadState | undefined
): T {
  if (session.id !== sessionId || !readState) return session;
  if (session.readState && !readStateSupersedes(readState, session.readState)) return session;
  return { ...session, readState };
}

export async function reconcileSessionReadState(result: SessionReadResult): Promise<void> {
  const readState = readStateFromResult(result);
  await Promise.all(
    [...readStateReconcilers].map((reconcile) =>
      reconcile({ sessionId: result.sessionId, outcome: result.outcome, readState })
    )
  );
}
