import {
  parseSessionListQuery,
  SESSION_LIST_CURRENT_USER,
} from "@open-inspect/shared/session-list-query";
import { sessionReadActionSchema } from "@open-inspect/shared/types/sessions";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { SessionIndexStore } from "../db/session-index";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";
import type { Env } from "../types";
import { createLogger } from "../logger";

const log = createLogger("session-read-state");

function parseCreatedByFilters(
  values: readonly string[],
  principal: RequestContext["principal"]
): string[] | Response {
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const userId =
      value === SESSION_LIST_CURRENT_USER
        ? principal?.kind === "user"
          ? principal.userId
          : null
        : value;

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
  const createdByUserIds = parseCreatedByFilters(createdBy, ctx.principal);

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const store = new SessionIndexStore(ctx.db);
  const listStartedAt = Date.now();
  const viewerUserId = ctx.principal?.kind === "user" ? ctx.principal.userId : undefined;
  const result = await store.list({
    status,
    excludeStatus,
    excludeAutomationLineage,
    createdByUserIds,
    limit,
    offset,
    viewerUserId,
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

async function handlePatchReadState(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "user") {
    return error("Human user authentication required", 403);
  }
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const unparsedBody = await parseJsonBody<unknown>(request);
  if (unparsedBody instanceof Response) return unparsedBody;
  const parsedBody = sessionReadActionSchema.safeParse(unparsedBody);
  if (!parsedBody.success) return error("Invalid session read action", 400);
  const body = parsedBody.data;

  const store = new SessionIndexStore(ctx.db);
  const visibleSession = await store.getVisibleForUser(sessionId, ctx.principal.userId);
  if (!visibleSession) return error("Session not found", 404);

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
  { method: "GET", pattern: parsePattern("/sessions"), handler: handleListSessions },
  {
    method: "PATCH",
    pattern: parsePattern("/sessions/:id/read-state"),
    handler: handlePatchReadState,
  },
  { method: "DELETE", pattern: parsePattern("/sessions/:id"), handler: handleDeleteSession },
];
