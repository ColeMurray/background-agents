import {
  sessionInboxCategorySchema,
  sessionInboxItemSchema,
  sessionInboxPageSchema,
  sessionInboxSessionSchema,
  sessionInboxSnapshotSchema,
  type SessionInboxCategory,
  type SessionInboxItem,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";
import type { SessionReadState } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import type { BrowserApiPath } from "./browser-api-fetch";
import { applySessionReadStateToItem, sessionReadStateClientSchema } from "./session-read-state";

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
  return sessionInboxPageClientSchema.parse(data);
}

export function parseSessionInboxSnapshot(data: unknown): SessionInboxSnapshot {
  return sessionInboxSnapshotClientSchema.parse(data);
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

function latestHierarchyUpdate(item: SessionInboxItem): number {
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
