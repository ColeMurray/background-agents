import {
  cancelChildSessionRequestSchema,
  type CancelChildSessionRequest,
} from "@open-inspect/shared";
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

  // An empty body means "no options"; older clients POST without one.
  let body: CancelChildSessionRequest = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return error("Invalid JSON body");
    }
    const parsed = cancelChildSessionRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return error("cancelNested must be a boolean");
    }
    body = parsed.data;
  }
  const cancelNested = body.cancelNested ?? true;

  const response = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.cancel, {
    method: "POST",
  });
  if (!response.ok && response.status !== 409) return response;
  if (!cancelNested) return response;

  const descendantIds = await sessionStore.listActiveDescendantIds(childId);
  const cancelledDescendantIds: string[] = [];
  const failedDescendantIds: string[] = [];
  for (const descendantId of descendantIds) {
    const descendantResponse = await ctx.sessionRuntime.fetch(
      descendantId,
      SessionInternalPaths.cancel,
      { method: "POST" }
    );
    if (descendantResponse.ok) {
      cancelledDescendantIds.push(descendantId);
    } else if (descendantResponse.status !== 409) {
      // 409 means the descendant reached a terminal state since the D1 query.
      failedDescendantIds.push(descendantId);
    }
  }
  if (failedDescendantIds.length > 0) {
    return json(
      {
        error: `Nested tasks could not be cancelled: ${failedDescendantIds.join(", ")}`,
        cancelledDescendantIds,
      },
      502
    );
  }

  // Cancelling descendants of an already-terminal child is still useful work;
  // report it as success rather than passing through the child's 409.
  if (response.ok || cancelledDescendantIds.length > 0) {
    return json({ status: "cancelled", cancelledDescendantIds });
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
