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
 * only from read-state responses, under the viewer who sent the request, so
 * one viewer's reads never render for another. A fetched row that catches up
 * with an entry simply wins at render; nothing is retired.
 */
export type SessionReadOverlay = ReadonlyMap<string, SessionReadState>;

const EMPTY_OVERLAY: SessionReadOverlay = new Map();
let overlays: ReadonlyMap<string, SessionReadOverlay> = new Map();
const overlayListeners = new Set<() => void>();

function replaceOverlays(next: ReadonlyMap<string, SessionReadOverlay>): void {
  overlays = next;
  for (const listener of overlayListeners) listener();
}

export function getSessionReadOverlay(viewerId: string | null): SessionReadOverlay {
  return (viewerId !== null && overlays.get(viewerId)) || EMPTY_OVERLAY;
}

export function subscribeSessionReadOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

/** Forgets every viewer's reads; tests start from a clean page. */
export function resetSessionReadOverlay(): void {
  if (overlays.size > 0) replaceOverlays(new Map());
}

/** Whether this page already read `messageId` for this viewer, so opening it again need not ask. */
export function isSessionMessageRead(
  viewerId: string,
  sessionId: string,
  messageId: string
): boolean {
  const entry = getSessionReadOverlay(viewerId).get(sessionId);
  return entry?.latestMessageId === messageId && !entry.unread;
}

function recordReadState(viewerId: string, sessionId: string, readState: SessionReadState): void {
  const entries = getSessionReadOverlay(viewerId);
  const current = entries.get(sessionId);
  if (current && !readStateSupersedes(readState, current)) return;
  if (
    current &&
    current.version === readState.version &&
    current.latestMessageId === readState.latestMessageId &&
    current.unread === readState.unread
  ) {
    return;
  }
  const next = new Map(entries);
  next.set(sessionId, readState);
  const nextOverlays = new Map(overlays);
  nextOverlays.set(viewerId, next);
  replaceOverlays(nextOverlays);
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
 */
export function applySessionReadResult(
  result: SessionReadResult,
  mutate: ScopedMutator,
  viewerId: string
): void {
  recordReadState(viewerId, result.sessionId, readStateFromResult(result));
  if (result.outcome === "marked_read" || result.outcome === "not_latest") {
    void mutate(isSessionInboxKey).catch((error: unknown) => {
      console.error("Failed to refresh session inbox after read", error);
    });
  }
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
  const rootSession = mergeReadState(item.rootSession, entries);
  let changed = rootSession !== item.rootSession;
  const descendantSessions = item.descendantSessions.map((session) => {
    const merged = mergeReadState(session, entries);
    if (merged !== session) changed = true;
    return merged;
  });
  return changed ? { rootSession, descendantSessions } : item;
}
