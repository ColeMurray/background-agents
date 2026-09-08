import { parseBody } from "./body";
import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
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
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  requirePermission,
  type RequestContext,
  type UserRouteContext,
} from "./shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "../db/session-inbox-cursor";
import { parseQuery } from "./query";

const sessionInboxQuerySchema = z.object({
  category: z
    .string()
    .optional()
    .transform((raw, context) => {
      if (raw === undefined) return null;
      const parsed = sessionInboxCategorySchema.safeParse(raw);
      if (!parsed.success) {
        context.addIssue({ code: "custom", message: "Invalid category" });
        return z.NEVER;
      }
      return parsed.data;
    }),
  cursor: z.string().min(1, { error: "Invalid cursor" }).optional(),
  mine: z.literal("true", { error: "Invalid mine" }).optional(),
});

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

export async function handleListSessions(
  request: Request,
  env: Env,
  _params: object,
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

export async function handleListSessionInbox(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const query = parseQuery(request, sessionInboxQuerySchema);
  if (query instanceof Response) return query;
  const { category, mine } = query;
  if (query.cursor !== undefined && category === null) {
    return error("Category required for pagination", 400);
  }
  const parsedCursor = parseSessionInboxCursor(query.cursor);
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
    category,
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
    category,
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

export async function handlePatchReadState(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const sessionId = params.id;

  const body = await parseBody(request, sessionReadActionSchema, "Invalid session read action");
  if (body instanceof Response) return body;

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

export async function handleDeleteSession(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const sessionId = params.id;

  const sessionStore = new SessionIndexStore(ctx.db);
  await sessionStore.delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes = new Hono<ControlPlaneHonoEnv>();

sessionIndexRoutes.get(
  "/sessions",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatch(c, handleListSessions)
);
sessionIndexRoutes.get(
  "/sessions/inbox",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("sessions.read", { service: "deny" }),
  }),
  (c) => dispatch(c, handleListSessionInbox)
);
sessionIndexRoutes.patch(
  "/sessions/:id/read-state",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatch(c, handlePatchReadState)
);
sessionIndexRoutes.delete(
  "/sessions/:id",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requirePermission("sessions.delete") }),
  (c) => dispatch(c, handleDeleteSession)
);
