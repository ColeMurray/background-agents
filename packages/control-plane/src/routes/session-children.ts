import { SessionIndexStore } from "../db/session-index";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

async function handleListChildren(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const children = await sessionStore.listByParent(parentId);

  return json({ children });
}

async function handleGetChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  const url = new URL(request.url);
  return ctx.sessionRuntime.fetch(
    childId,
    SessionInternalPaths.childSummary,
    undefined,
    url.search
  );
}

export async function handleCancelChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  let cancelNested: unknown;
  const rawBody = await request.text();
  try {
    const body: unknown = rawBody.trim() ? JSON.parse(rawBody) : undefined;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      cancelNested = (body as { cancelNested?: unknown }).cancelNested;
    }
  } catch {
    return error("Invalid JSON body");
  }
  if (cancelNested !== undefined && typeof cancelNested !== "boolean") {
    return error("cancelNested must be a boolean");
  }

  const response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.cancel, {
    method: "POST",
  });
  if (!response.ok && response.status !== 409) return response;
  if (cancelNested === false) return response;

  const descendantIds = await sessionStore.listActiveDescendantIds(childId);
  const failedDescendantIds: string[] = [];
  for (const descendantId of descendantIds) {
    const descendantResponse = await ctx.sessionRuntime.fetch(
      descendantId,
      SessionInternalPaths.cancel,
      { method: "POST" }
    );
    // A descendant may have reached a terminal state since the D1 query.
    if (!descendantResponse.ok && descendantResponse.status !== 409) {
      failedDescendantIds.push(descendantId);
    }
  }
  if (failedDescendantIds.length > 0) {
    return error(
      `Task cancelled, but nested tasks could not be cancelled: ${failedDescendantIds.join(", ")}`,
      502
    );
  }

  return response;
}

export const sessionChildRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleListChildren,
  },
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/children/:childId"),
    handler: handleGetChild,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/children/:childId/cancel"),
    handler: handleCancelChild,
  }),
];
