import { sessionReadActionSchema, type SessionStatus } from "@open-inspect/shared/types/sessions";
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

function parseCreatedByFilters(
  searchParams: URLSearchParams,
  principal: RequestContext["principal"]
): string[] | Response {
  const values = searchParams.getAll("createdBy");
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const userId = value === "me" ? (principal?.kind === "user" ? principal.userId : null) : value;

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

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parsePaginationLimit(url.searchParams.get("limit"));
  const offset = parsePaginationOffset(url.searchParams.get("offset"));
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const excludeAutomationLineageParam = url.searchParams.get("excludeAutomationLineage");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const excludeAutomationLineage = excludeAutomationLineageParam === "true";
  const createdByUserIds = parseCreatedByFilters(url.searchParams, ctx.principal);

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  if (
    excludeAutomationLineageParam !== null &&
    excludeAutomationLineageParam !== "true" &&
    excludeAutomationLineageParam !== "false"
  ) {
    return error("Invalid excludeAutomationLineage", 400);
  }

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
