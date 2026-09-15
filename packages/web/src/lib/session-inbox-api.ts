import {
  sessionInboxCategorySchema,
  sessionInboxItemSchema,
  sessionInboxPageSchema,
  sessionInboxSessionSchema,
  sessionInboxSnapshotSchema,
  type SessionInboxCategory,
  type SessionInboxItem,
  type SessionInboxPage,
  type SessionInboxSession,
  type SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";
import type { SessionReadState } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import type { BrowserApiPath } from "./browser-api-fetch";
import { applySessionReadStateToItem, sessionReadStateClientSchema } from "./session-read-state";
import {
  applySessionTitleRevision,
  type SessionTitleRevision,
} from "./session-title-reconciliation";

const sessionInboxSessionClientSchema = sessionInboxSessionSchema.extend({
  readState: sessionReadStateClientSchema,
});
const sessionInboxItemClientSchema = sessionInboxItemSchema.extend({
  rootSession: sessionInboxSessionClientSchema,
  descendantSessions: z.array(sessionInboxSessionClientSchema),
});
const sessionInboxPageClientSchema = z
  .object({
    items: z.array(sessionInboxItemClientSchema),
  })
  .passthrough()
  .pipe(sessionInboxPageSchema);
const sessionInboxSnapshotClientSchema = z
  .object({
    categories: z.record(sessionInboxCategorySchema, sessionInboxPageClientSchema),
  })
  .passthrough()
  .pipe(sessionInboxSnapshotSchema);

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

export function isSessionInboxPaginationKey(key: unknown): boolean {
  return Array.isArray(key) && isSessionInboxKey(key[0]);
}

export function parseSessionInboxPage(data: unknown): SessionInboxPage {
  return applyKnownTitleRevisionsToPage(sessionInboxPageClientSchema.parse(data));
}

export function parseSessionInboxSnapshot(data: unknown): SessionInboxSnapshot {
  const parsed = sessionInboxSnapshotClientSchema.parse(data);
  return {
    ...parsed,
    categories: Object.fromEntries(
      Object.entries(parsed.categories).map(([category, page]) => [
        category,
        applyKnownTitleRevisionsToPage(page),
      ])
    ) as Record<SessionInboxCategory, SessionInboxPage>,
  };
}

function applyTitleToSession(
  session: SessionInboxSession,
  sessionId: string,
  title: string | null,
  updatedAt?: number
) {
  if (session.id !== sessionId || (updatedAt !== undefined && updatedAt < session.updatedAt)) {
    return session;
  }
  return { ...session, title, updatedAt: updatedAt ?? session.updatedAt };
}

function applyTitleToPage(
  page: SessionInboxPage,
  sessionId: string,
  title: string | null,
  updatedAt?: number
): SessionInboxPage {
  return {
    ...page,
    items: page.items
      .map((item) => ({
        rootSession: applyTitleToSession(item.rootSession, sessionId, title, updatedAt),
        descendantSessions: item.descendantSessions.map((session) =>
          applyTitleToSession(session, sessionId, title, updatedAt)
        ),
      }))
      .sort((a, b) => latestHierarchyUpdate(b) - latestHierarchyUpdate(a)),
  };
}

function applyKnownTitleRevisionsToPage(page: SessionInboxPage): SessionInboxPage {
  return {
    ...page,
    items: page.items
      .map((item) => ({
        rootSession: applySessionTitleRevision(item.rootSession),
        descendantSessions: item.descendantSessions.map(applySessionTitleRevision),
      }))
      .sort((a, b) => latestHierarchyUpdate(b) - latestHierarchyUpdate(a)),
  };
}

function applyReadStateToPage(
  page: SessionInboxPage,
  sessionId: string,
  readState: SessionReadState
): SessionInboxPage {
  return {
    ...page,
    items: page.items.map((item) => applySessionInboxItemReadState(item, sessionId, readState)),
  };
}

export function latestHierarchyUpdate(item: SessionInboxItem): number {
  return Math.max(
    item.rootSession.updatedAt,
    ...item.descendantSessions.map(({ updatedAt }) => updatedAt)
  );
}

/** Attention membership is unread-driven: a hierarchy stays while any session is unread. */
export function isSessionInboxItemFullyRead(item: SessionInboxItem): boolean {
  return (
    !item.rootSession.readState.unread &&
    item.descendantSessions.every((session) => !session.readState.unread)
  );
}

/** Where a fully read hierarchy lands; mirrors the category rule in the inbox query. */
export function sessionInboxDestinationCategory(
  item: SessionInboxItem
): Exclude<SessionInboxCategory, "needs_attention"> {
  return item.rootSession.status === "active" ||
    item.descendantSessions.some(({ status }) => status === "active")
    ? "in_progress"
    : "finished";
}

export function applySessionInboxItemReadState(
  item: SessionInboxItem,
  sessionId: string,
  readState: SessionReadState
): SessionInboxItem {
  return {
    rootSession: applySessionReadStateToItem(item.rootSession, sessionId, readState),
    descendantSessions: item.descendantSessions.map((session) =>
      applySessionReadStateToItem(session, sessionId, readState)
    ),
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
  title: string | null,
  updatedAt?: number
): T | undefined {
  if (!data) return data;
  if ("categories" in data) {
    return {
      ...data,
      categories: Object.fromEntries(
        Object.entries(data.categories).map(([category, page]) => [
          category,
          applyTitleToPage(page, sessionId, title, updatedAt),
        ])
      ) as Record<SessionInboxCategory, SessionInboxPage>,
    };
  }
  return applyTitleToPage(data, sessionId, title, updatedAt) as T;
}

export function applySessionInboxItemTitleRevision(
  item: SessionInboxItem,
  revision: SessionTitleRevision
): SessionInboxItem {
  return {
    rootSession: applyTitleToSession(
      item.rootSession,
      revision.sessionId,
      revision.title,
      revision.updatedAt
    ),
    descendantSessions: item.descendantSessions.map((session) =>
      applyTitleToSession(session, revision.sessionId, revision.title, revision.updatedAt)
    ),
  };
}

export function applySessionInboxReadStateUpdate<T extends SessionInboxSnapshot | SessionInboxPage>(
  data: T | undefined,
  sessionId: string,
  readState: SessionReadState
): T | undefined {
  if (!data) return data;
  if ("categories" in data) {
    const categories = Object.fromEntries(
      Object.entries(data.categories).map(([category, page]) => [
        category,
        applyReadStateToPage(page, sessionId, readState),
      ])
    ) as Record<SessionInboxCategory, SessionInboxPage>;
    const attentionItem = categories.needs_attention.items.find(
      (item) =>
        item.rootSession.id === sessionId ||
        item.descendantSessions.some((session) => session.id === sessionId)
    );
    if (attentionItem && isSessionInboxItemFullyRead(attentionItem)) {
      categories.needs_attention = {
        ...categories.needs_attention,
        items: categories.needs_attention.items.filter(
          (item) => item.rootSession.id !== attentionItem.rootSession.id
        ),
      };
      const destination = sessionInboxDestinationCategory(attentionItem);
      categories[destination] = {
        ...categories[destination],
        items: [
          attentionItem,
          ...categories[destination].items.filter(
            (item) => item.rootSession.id !== attentionItem.rootSession.id
          ),
        ].sort((a, b) => latestHierarchyUpdate(b) - latestHierarchyUpdate(a)),
      };
    }
    return {
      ...data,
      categories,
    } as T;
  }
  return applyReadStateToPage(data, sessionId, readState) as T;
}

export type { SessionInboxItem, SessionInboxPage, SessionInboxSnapshot };
