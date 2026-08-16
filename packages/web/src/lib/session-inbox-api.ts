import type {
  SessionInboxCategory,
  SessionInboxItem,
  SessionInboxPage,
  SessionInboxSnapshot,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import type { BrowserApiPath } from "./browser-api-fetch";

export const SESSION_INBOX_API_PATH = "/api/sessions/inbox";

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
 * Applies a rename to a cached inbox payload. Inbox keys cache two shapes —
 * the category snapshot and a single paginated page — so the transform
 * dispatches on the presence of `categories`.
 */
export function applySessionInboxTitleUpdate<T extends SessionInboxSnapshot | SessionInboxPage>(
  data: T | undefined,
  sessionId: string,
  title: string | null
): T | undefined {
  if (!data) return data;
  if ("categories" in data) {
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
  return applyTitleToPage(data, sessionId, title) as T;
}

export type { SessionInboxItem, SessionInboxPage, SessionInboxSnapshot };
