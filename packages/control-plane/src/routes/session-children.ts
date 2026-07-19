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

async function handleCancelChild(
  _request: Request,
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

  return ctx.sessionRuntime.fetch(childId, SessionInternalPaths.cancel, { method: "POST" });
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
