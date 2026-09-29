import { parseBody } from "./body";
import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  parseSessionListQuery,
  parseSessionListTeamIds,
  SESSION_LIST_CURRENT_USER,
} from "@open-inspect/shared/session-list-query";
import {
  SESSION_INBOX_CATEGORIES,
  sessionInboxCategorySchema,
  sessionInboxPageSchema,
  sessionInboxSnapshotSchema,
} from "@open-inspect/shared/types/session-inbox";
import {
  sessionListResponseSchema,
  sessionReadActionSchema,
} from "@open-inspect/shared/types/sessions";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { SessionIndexStore } from "../db/session-index";
import {
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  requirePermission,
  requireSession,
  type RequestContext,
  type UserRouteContext,
} from "./shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "../db/session-inbox-cursor";
import { parseQuery } from "./query";
import { TeamMembershipStore } from "../db/team-memberships";
import { D1QueryParameterLimitError } from "../db/query-limits";
import { teamsEnforcementMode, viewerFromContext } from "../authorization/session-admission";

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

async function readSessionList<T>(read: () => Promise<T>): Promise<T | Response> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof D1QueryParameterLimitError) return error(cause.message, 400);
    throw cause;
  }
}

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

  const {
    createdBy,
    status,
    excludeStatus,
    excludeAutomationLineage,
    q,
    repoOwner,
    repoName,
    environmentId,
    origin,
    limit,
    offset,
    teamIds,
    ownerFilter,
    visibility,
    scope,
  } = parsedQuery.data;
  const viewerUserId =
    ctx.principal?.kind === "user"
      ? ctx.principal.userId
      : ctx.principal?.kind === "service"
        ? (ctx.principal.actor?.canonicalUserId ?? ctx.authorization?.userId)
        : undefined;
  const legacyStarted =
    ownerFilter === undefined &&
    createdBy.length === 1 &&
    createdBy[0] === SESSION_LIST_CURRENT_USER;
  if (legacyStarted && !isCanonicalUserId(viewerUserId)) return error("Invalid createdBy", 400);
  const createdByUserIds = parseCreatedByFilters(
    legacyStarted ? [] : createdBy,
    viewerUserId ?? null
  );

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const viewer = viewerFromContext(
    ctx,
    ctx.authorization
      ? (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
          ctx.authorization.userId
        ))
      : new Map()
  );
  if (
    scope === "all" &&
    (viewer.kind !== "user" || !["owner", "administrator"].includes(viewer.roleKey ?? ""))
  ) {
    return error("Invalid scope", 403);
  }
  if (ownerFilter && ownerFilter !== "anyone" && viewer.kind !== "user") {
    return error("Invalid ownerFilter", 400);
  }

  const store = new SessionIndexStore(ctx.db);
  const listStartedAt = Date.now();
  const result = await readSessionList(() =>
    store.list({
      status,
      excludeStatus,
      excludeAutomationLineage,
      createdByUserIds,
      ...(teamIds ? { teamIds } : {}),
      ownerFilter: ownerFilter ?? (legacyStarted ? "started" : "anyone"),
      visibility,
      scope,
      viewer,
      mode: teamsEnforcementMode(ctx, env),
      ...(q ? { search: q } : {}),
      ...(repoOwner && repoName ? { repository: { repoOwner, repoName } } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(origin ? { spawnSource: origin } : {}),
      limit,
      offset,
      ...(viewerUserId ? { viewerUserId } : {}),
    })
  );
  if (result instanceof Response) return result;
  if (viewerUserId) {
    log.info("session_read_state.decorated", {
      event: "session_read_state.decorated",
      session_count: result.sessions.length,
      duration_ms: Date.now() - listStartedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  const response = json(
    sessionListResponseSchema.parse({
      sessions: result.sessions,
      hasMore: result.hasMore,
    })
  );
  if (viewerUserId) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

export async function handleListSessionInbox(
  request: Request,
  env: Env,
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
  const teamIds = parseSessionListTeamIds(new URL(request.url).searchParams);
  if (teamIds === null) {
    return error("Invalid teamIds[]", 400);
  }
  const viewer = viewerFromContext(
    ctx,
    (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
      ctx.principal.userId
    ))
  );

  const startedAt = Date.now();
  const store = new SessionIndexStore(ctx.db);
  const commonOptions = {
    limit: SESSION_INBOX_LIMIT,
    createdByUserIds: mine === "true" ? [ctx.principal.userId] : [],
    excludeAutomatedSessions: mine === "true",
    viewerUserId: ctx.principal.userId,
    viewer,
    mode: teamsEnforcementMode(ctx, env),
    teamIds,
  };

  if (category === null) {
    const snapshot = await readSessionList(() => store.listInboxSnapshot(commonOptions));
    if (snapshot instanceof Response) return snapshot;
    const body = sessionInboxSnapshotSchema.parse({
      categories: Object.fromEntries(
        SESSION_INBOX_CATEGORIES.map((inboxCategory) => [
          inboxCategory,
          encodeInboxPage(snapshot[inboxCategory]),
        ])
      ),
    });
    const response = json(body);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const result = await readSessionList(() =>
    store.listInbox({
      ...commonOptions,
      category,
      cursor: parsedCursor.cursor,
    })
  );
  if (result instanceof Response) return result;
  const nextCursor = result.nextCursor ? encodeSessionInboxCursor(result.nextCursor) : null;
  const response = json(
    sessionInboxPageSchema.parse({
      items: result.items,
      hasMore: result.hasMore,
      nextCursor,
    })
  );
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

function encodeInboxPage(result: Awaited<ReturnType<SessionIndexStore["listInbox"]>>) {
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
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") }),
  (c) => dispatch(c, handlePatchReadState)
);
sessionIndexRoutes.delete(
  "/sessions/:id",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requireSession("delete") }),
  (c) => dispatch(c, handleDeleteSession)
);
