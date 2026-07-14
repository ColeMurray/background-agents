import { isCanonicalUserId, type SessionStatus } from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import type { Env } from "../types";

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];

function parseSessionStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  return SESSION_STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : undefined;
}

function parseCreatedByFilters(searchParams: URLSearchParams): string[] | Response {
  const values = searchParams.getAll("createdBy");
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!isCanonicalUserId(value)) {
      return error("Invalid createdBy", 400);
    }

    if (!seen.has(value)) {
      seen.add(value);
      userIds.push(value);
    }
  }

  return userIds;
}

function parsePaginationLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parsePaginationOffset(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

function parseSidebarCursor(
  value: string | null
): { activityAt: number; rootSessionId: string } | null | Response {
  if (!value) return null;
  const separator = value.indexOf(":");
  const activityAt = Number(value.slice(0, separator));
  const rootSessionId = value.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(activityAt) || activityAt < 0 || !rootSessionId) {
    return error("Invalid cursor", 400);
  }
  return { activityAt, rootSessionId };
}

function encodeSidebarCursor(cursor: { activityAt: number; rootSessionId: string } | null) {
  return cursor ? `${cursor.activityAt}:${cursor.rootSessionId}` : null;
}

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parsePaginationLimit(url.searchParams.get("limit"));
  const offset = parsePaginationOffset(url.searchParams.get("offset"));
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const createdByUserIds = parseCreatedByFilters(url.searchParams);
  const view = url.searchParams.get("view");

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const store = new SessionIndexStore(env.DB);
  if (view === "sidebar") {
    const cursor = parseSidebarCursor(url.searchParams.get("cursor"));
    if (cursor instanceof Response) return cursor;
    const result = await store.listSidebar({
      createdByUserIds,
      limit,
      cursor: cursor ?? undefined,
    });
    return json({
      trees: result.trees,
      nextCursor: encodeSidebarCursor(result.nextCursor),
    });
  }
  if (view) return error("Invalid view", 400);

  const result = await store.list({ status, excludeStatus, createdByUserIds, limit, offset });

  return json({
    sessions: result.sessions,
    hasMore: result.hasMore,
  });
}

async function handleDeleteSession(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/sessions"), handler: handleListSessions },
  { method: "DELETE", pattern: parsePattern("/sessions/:id"), handler: handleDeleteSession },
];
