import type { ScopedMutator } from "swr";
import { browserApiFetch } from "./browser-api-fetch";
import { isSessionInboxKey } from "./session-inbox-api";
import type { SandboxEvent } from "@/types/session";
import type { SessionInboxItem } from "@open-inspect/shared/types/session-inbox";
import {
  sessionReadResultSchema,
  type SessionReadAction,
  type SessionReadResult,
  type SessionReadState,
} from "@open-inspect/shared/types/sessions";

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

/**
 * Read state the viewer established in this page, keyed by session ID.
 *
 * Fetched inbox rows are never edited. Each row is merged with its overlay
 * entry at render and the higher version wins, so a read shows on every row
 * at once, including pages loaded through "Load more". Entries are written
 * only from read-state responses and retire once a fetched row catches up.
 */
export type SessionReadOverlay = ReadonlyMap<string, SessionReadState>;

let overlay: SessionReadOverlay = new Map();
let overlayOwner: string | null = null;
const overlayListeners = new Set<() => void>();

function replaceOverlay(next: SessionReadOverlay): void {
  overlay = next;
  for (const listener of overlayListeners) listener();
}

export function getSessionReadOverlay(): SessionReadOverlay {
  return overlay;
}

export function subscribeSessionReadOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

export function resetSessionReadOverlay(): void {
  overlayOwner = null;
  if (overlay.size > 0) replaceOverlay(new Map());
}

/** Reads belong to one viewer: a sign-out or account switch forgets them. */
export function scopeSessionReadOverlay(userId: string | null): void {
  if (userId === overlayOwner) return;
  resetSessionReadOverlay();
  overlayOwner = userId;
}

/** Whether this page already read `messageId`, so opening it again need not ask. */
export function isSessionMessageRead(sessionId: string, messageId: string): boolean {
  const entry = overlay.get(sessionId);
  return entry?.latestMessageId === messageId && !entry.unread;
}

function recordReadState(sessionId: string, readState: SessionReadState): void {
  const current = overlay.get(sessionId);
  if (current && !readStateSupersedes(readState, current)) return;
  if (
    current &&
    current.version === readState.version &&
    current.latestMessageId === readState.latestMessageId &&
    current.unread === readState.unread
  ) {
    return;
  }
  const next = new Map(overlay);
  next.set(sessionId, readState);
  replaceOverlay(next);
}

/**
 * Settles a read-state response for the viewer who sent the request.
 *
 * The overlay shows the result immediately. A result that can change where
 * the server places the session (`marked_read`, or `not_latest` carrying a
 * newer unread message) refetches the inbox; the client never moves a
 * session between categories itself. The refetch is independent of the
 * acknowledgement: a failed refresh is SWR's to retry, not a reason to send
 * the read again.
 *
 * Returns false when the viewer changed while the request was in flight;
 * the result belongs to the previous viewer and is dropped.
 */
export function applySessionReadResult(
  result: SessionReadResult,
  mutate: ScopedMutator,
  viewerId: string
): boolean {
  if (viewerId !== overlayOwner) return false;
  recordReadState(result.sessionId, readStateFromResult(result));
  if (result.outcome === "marked_read" || result.outcome === "not_latest") {
    void mutate(isSessionInboxKey).catch((error: unknown) => {
      console.error("Failed to refresh session inbox after read", error);
    });
  }
  return true;
}

/** Retires overlay entries that fetched rows have caught up with. */
export function pruneSessionReadOverlay(
  sessions: Iterable<{ id: string; readState: SessionReadState }>
): void {
  let next: Map<string, SessionReadState> | null = null;
  for (const session of sessions) {
    const entry = overlay.get(session.id);
    if (!entry || !readStateSupersedes(session.readState, entry)) continue;
    next ??= new Map(overlay);
    next.delete(session.id);
  }
  if (next) replaceOverlay(next);
}

function mergeReadState<T extends { id: string; readState: SessionReadState }>(
  session: T,
  entries: SessionReadOverlay
): T {
  const entry = entries.get(session.id);
  if (!entry || !readStateSupersedes(entry, session.readState)) return session;
  return { ...session, readState: entry };
}

export function applySessionReadOverlay(
  item: SessionInboxItem,
  entries: SessionReadOverlay
): SessionInboxItem {
  if (entries.size === 0) return item;
  return {
    rootSession: mergeReadState(item.rootSession, entries),
    descendantSessions: item.descendantSessions.map((session) => mergeReadState(session, entries)),
  };
}
