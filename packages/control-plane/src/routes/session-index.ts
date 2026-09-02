import {
  parseSessionListQuery,
  SESSION_LIST_CURRENT_USER,
} from "@open-inspect/shared/session-list-query";
import {
  sessionInboxCategorySchema,
  type SessionInboxCategory,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";
import { sessionReadActionSchema } from "@open-inspect/shared/types/sessions";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { SessionIndexStore } from "../db/session-index";
import {
  error,
  defineRoute,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  parseJsonBody,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  requirePermission,
  type RequestContext,
  type Route,
  type UserRouteContext,
} from "./shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "../db/session-inbox-cursor";

const log = createLogger("session-read-state");
const SESSION_INBOX_LIMIT = 20;

function parseCreatedByFilters(
  values: readonly string[],
  currentUserId: string | null
): string[] | Response {
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const userId = value === SESSION_LIST_CURRENT_USER ? currentUserId : value;

    if (!isCanonicalUserId(userId)) {
      return error("Invalid createdBy", 400);
    }

    if (!seen.has(userId)) {
      seen.add(userId);
      userIds.push(userId);
    }
  }

  return userIds;
}

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const parsedQuery = parseSessionListQuery(url.searchParams);
  if (!parsedQuery.success) return error(`Invalid ${parsedQuery.invalidParam}`, 400);

  const { createdBy, status, excludeStatus, excludeAutomationLineage, limit, offset } =
    parsedQuery.data;
  const viewerUserId =
    ctx.principal?.kind === "user"
      ? ctx.principal.userId
      : ctx.principal?.kind === "service"
        ? (ctx.principal.actor?.canonicalUserId ?? ctx.authorization?.userId)
        : undefined;
  const createdByUserIds = parseCreatedByFilters(createdBy, viewerUserId ?? null);

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const store = new SessionIndexStore(ctx.db);
  const listStartedAt = Date.now();
  const result = await store.list({
    status,
    excludeStatus,
    excludeAutomationLineage,
    createdByUserIds,
    limit,
    offset,
    ...(viewerUserId ? { viewerUserId } : {}),
  });
  if (viewerUserId) {
    log.info("session_read_state.decorated", {
      event: "session_read_state.decorated",
      session_count: result.sessions.length,
      duration_ms: Date.now() - listStartedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  const response = json({
    sessions: result.sessions,
    hasMore: result.hasMore,
  });
  if (viewerUserId) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

async function handleListSessionInbox(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const categoryValue = searchParams.get("category");
  const category =
    categoryValue === null ? null : sessionInboxCategorySchema.safeParse(categoryValue);
  if (category && !category.success) return error("Invalid category", 400);
  const cursor = searchParams.get("cursor");
  if (cursor === "") return error("Invalid cursor", 400);
  if (cursor !== null && category === null) return error("Category required for pagination", 400);
  const mine = searchParams.get("mine");
  if (mine !== null && mine !== "true") return error("Invalid mine", 400);
  const parsedCursor = parseSessionInboxCursor(cursor);
  if (!parsedCursor.ok) return error(parsedCursor.error, 400);

  const startedAt = Date.now();
  const store = new SessionIndexStore(ctx.db);
  const commonOptions = {
    limit: SESSION_INBOX_LIMIT,
    createdByUserIds: mine === "true" ? [ctx.principal.userId] : [],
    excludeAutomatedSessions: mine === "true",
    viewerUserId: ctx.principal.userId,
  };

  if (category === null) {
    const snapshot = await store.listInboxSnapshot(commonOptions);
    const categories = Object.fromEntries(
      (Object.keys(snapshot) as SessionInboxCategory[]).map((inboxCategory) => [
        inboxCategory,
        encodeInboxPage(snapshot[inboxCategory]),
      ])
    ) as Record<SessionInboxCategory, SessionInboxPage>;
    const body: SessionInboxSnapshot = { categories };
    const response = json(body);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const result = await store.listInbox({
    ...commonOptions,
    category: category.data,
    cursor: parsedCursor.cursor,
  });
  const nextCursor = result.nextCursor ? encodeSessionInboxCursor(result.nextCursor) : null;
  const response = json({
    items: result.items,
    hasMore: result.hasMore,
    nextCursor,
  });
  response.headers.set("Cache-Control", "private, no-store");
  log.info("session_inbox.listed", {
    event: "session_inbox.listed",
    category: category.data,
    hierarchy_count: result.items.length,
    session_count: result.items.reduce(
      (count, item) => count + 1 + item.descendantSessions.length,
      0
    ),
    duration_ms: Date.now() - startedAt,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return response;
}

function encodeInboxPage(
  result: Awaited<ReturnType<SessionIndexStore["listInbox"]>>
): SessionInboxPage {
  return {
    items: result.items,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeSessionInboxCursor(result.nextCursor) : null,
  };
}

async function handlePatchReadState(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const unparsedBody = await parseJsonBody<unknown>(request);
  if (unparsedBody instanceof Response) return unparsedBody;
  const parsedBody = sessionReadActionSchema.safeParse(unparsedBody);
  if (!parsedBody.success) return error("Invalid session read action", 400);
  const body = parsedBody.data;

  const store = new SessionIndexStore(ctx.db);
  const result = await store.updateReadState(ctx.principal.userId, sessionId, body);
  if (!result) return error("Session not found", 404);

  const response = json(result);
  response.headers.set("Cache-Control", "private, no-store");
  log.info("session_read_state.updated", {
    event: "session_read_state.updated",
    session_id: sessionId,
    action: body.action,
    outcome: result.outcome,
    unread: result.unread,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return response;
}

async function handleDeleteSession(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const sessionStore = new SessionIndexStore(ctx.db);
  await sessionStore.delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes: Route[] = [
  defineRoute(GITHUB_USER_OR_SERVICE_ROUTE, {
    method: "GET",
    path: "/sessions",
    authorization: requirePermission("sessions.read"),
    handler: handleListSessions,
  }),
  defineRoute(SCM_AGNOSTIC_HUMAN_USER_ROUTE, {
    method: "GET",
    path: "/sessions/inbox",
    authorization: requirePermission("sessions.read", { service: "deny" }),
    handler: handleListSessionInbox,
  }),
  defineRoute(SCM_AGNOSTIC_HUMAN_USER_ROUTE, {
    method: "PATCH",
    path: "/sessions/:id/read-state",
    authorization: requirePermission("sessions.read"),
    handler: handlePatchReadState,
  }),
  defineRoute(GITHUB_USER_OR_SERVICE_ROUTE, {
    method: "DELETE",
    path: "/sessions/:id",
    authorization: requirePermission("sessions.delete"),
    handler: handleDeleteSession,
  }),
];
