import type {
  SessionInboxCategory,
  SessionInboxItem,
  SessionInboxPage,
  SessionInboxSnapshot,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import type { BrowserApiPath } from "./browser-api-fetch";

const SESSION_INBOX_API_PATH = "/api/sessions/inbox";

interface SessionInboxQuery {
  category: SessionInboxCategory;
  cursor?: string;
  mine?: boolean;
}

export function buildSessionInboxKey(query: SessionInboxQuery): BrowserApiPath {
  const params = new URLSearchParams({ category: query.category });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.mine) params.set("mine", "true");
  return `${SESSION_INBOX_API_PATH}?${params.toString()}`;
}

export function buildSessionInboxSnapshotKey(mine: boolean): BrowserApiPath {
  return `${SESSION_INBOX_API_PATH}${mine ? "?mine=true" : ""}`;
}

export function isSessionInboxKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    (key === SESSION_INBOX_API_PATH || key.startsWith(`${SESSION_INBOX_API_PATH}?`))
  );
}

function applyTitleToSession(session: SessionListItem, sessionId: string, title: string | null) {
  return session.id === sessionId ? { ...session, title } : session;
}

function applyTitleToPage(
  page: SessionInboxPage,
  sessionId: string,
  title: string | null
): SessionInboxPage {
  return {
    ...page,
    items: page.items.map((item) => ({
      rootSession: applyTitleToSession(item.rootSession, sessionId, title),
      descendantSessions: item.descendantSessions.map((session) =>
        applyTitleToSession(session, sessionId, title)
      ),
    })),
  };
}

/**
 * Attention membership is unread-driven, as in the inbox query's category
 * rule (`MAX(unread) = 1`): a hierarchy stays while any session in it is
 * unread. This is the only category rule the client evaluates.
 */
export function isSessionInboxItemFullyRead(item: SessionInboxItem): boolean {
  return (
    !item.rootSession.readState.unread &&
    item.descendantSessions.every((session) => !session.readState.unread)
  );
}

/** Applies a rename to the cached inbox snapshot. Loaded pages are React state, not cache. */
export function applySessionInboxTitleUpdate(
  data: SessionInboxSnapshot | undefined,
  sessionId: string,
  title: string | null
): SessionInboxSnapshot | undefined {
  if (!data) return data;
  return {
    ...data,
    categories: Object.fromEntries(
      Object.entries(data.categories).map(([category, page]) => [
        category,
        applyTitleToPage(page, sessionId, title),
      ])
    ) as Record<SessionInboxCategory, SessionInboxPage>,
  };
}

export type { SessionInboxItem, SessionInboxPage, SessionInboxSnapshot };
