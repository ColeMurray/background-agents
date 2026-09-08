import { applyIdentityEnforcement } from "../auth/identity-enforcement";
import { SessionInternalPaths, type SessionInternalPath } from "../session/contracts";
import type { Env } from "../types";
import { error, parseJsonBody, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

type SimpleProxyRouteConfig = {
  method: string;
  routePath: string;
  internalPath: SessionInternalPath;
  runtimeMethod?: string;
  forwardSearch?: boolean;
  notFoundMessage?: string;
};

function getSessionId(match: RegExpMatchArray): string | Response {
  const sessionId = match.groups?.id;
  return sessionId ? sessionId : error("Session ID required");
}

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function simpleProxyRoute(config: SimpleProxyRouteConfig): Route {
  return sessionRoute({
    method: config.method,
    pattern: parsePattern(config.routePath),
    handler: async (request, _env, match, ctx) => {
      const sessionId = getSessionId(match);
      if (sessionId instanceof Response) return sessionId;

      const response = await ctx.sessionRuntime.fetch(
        sessionId,
        config.internalPath,
        config.runtimeMethod ? { method: config.runtimeMethod } : undefined,
        config.forwardSearch ? new URL(request.url).search : undefined
      );

      if (config.notFoundMessage && response.status === 404) {
        return error(config.notFoundMessage, 404);
      }

      return response;
    },
  });
}

async function handleAddParticipant(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = getSessionId(match);
  if (sessionId instanceof Response) return sessionId;

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;

  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.participants, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function handleCreatePR(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = getSessionId(match);
  if (sessionId instanceof Response) return sessionId;

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  if (!isObjectBody(body)) return error("JSON body must be an object");

  if (
    typeof body.title !== "string" ||
    typeof body.body !== "string" ||
    body.title.trim().length === 0 ||
    body.body.trim().length === 0
  ) {
    return error("title and body are required");
  }

  if (body.baseBranch != null && typeof body.baseBranch !== "string") {
    return error("baseBranch must be a string");
  }

  if (body.headBranch != null && typeof body.headBranch !== "string") {
    return error("headBranch must be a string");
  }

  if (body.repoOwner != null && typeof body.repoOwner !== "string") {
    return error("repoOwner must be a string");
  }

  if (body.repoName != null && typeof body.repoName !== "string") {
    return error("repoName must be a string");
  }

  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.createPr, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: body.title,
      body: body.body,
      baseBranch: body.baseBranch,
      headBranch: body.headBranch,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
    }),
  });
}

/**
 * Read a lifecycle-route body (title/archive/unarchive) under identity
 * enforcement. Lifecycle routes accept bodyless requests — a parse failure
 * just yields no fields. The DO participant check runs against the verified
 * identity, never a caller-asserted one.
 */
async function readEnforcedLifecycleBody(
  request: Request,
  ctx: SessionRouteContext
): Promise<{ userId?: string; title?: string; rejection?: Response }> {
  let body: { title?: string } = {};
  try {
    const parsed: unknown = await request.json();
    if (isObjectBody(parsed)) body = parsed;
  } catch {
    // Body parsing failed, continue without fields.
  }

  const enforcement = applyIdentityEnforcement(ctx, "session-lifecycle", body);
  if (enforcement.rejection) return { rejection: enforcement.rejection };

  return { userId: enforcement.enforced.participantUserId ?? undefined, title: body.title };
}

function lifecycleProxyRoute(
  method: string,
  routePath: string,
  internalPath: SessionInternalPath
): Route {
  return sessionRoute({
    method,
    pattern: parsePattern(routePath),
    handler: async (request, _env, match, ctx) => {
      const sessionId = getSessionId(match);
      if (sessionId instanceof Response) return sessionId;

      const { userId, title, rejection } = await readEnforcedLifecycleBody(request, ctx);
      if (rejection) return rejection;

      return ctx.sessionRuntime.fetch(sessionId, internalPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          internalPath === SessionInternalPaths.updateTitle ? { userId, title } : { userId }
        ),
      });
    },
  });
}

export const sessionRuntimeProxyRoutes: Route[] = [
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id",
    internalPath: SessionInternalPaths.state,
    notFoundMessage: "Session not found",
  }),
  simpleProxyRoute({
    method: "POST",
    routePath: "/sessions/:id/stop",
    internalPath: SessionInternalPaths.stop,
    runtimeMethod: "POST",
  }),
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id/events",
    internalPath: SessionInternalPaths.events,
    forwardSearch: true,
  }),
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id/artifacts",
    internalPath: SessionInternalPaths.artifacts,
  }),
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id/participants",
    internalPath: SessionInternalPaths.participants,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/participants"),
    handler: handleAddParticipant,
  }),
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id/messages",
    internalPath: SessionInternalPaths.messages,
    forwardSearch: true,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/pr"),
    handler: handleCreatePR,
  }),
  simpleProxyRoute({
    method: "POST",
    routePath: "/sessions/:id/openai-token-refresh",
    internalPath: SessionInternalPaths.openaiTokenRefresh,
    runtimeMethod: "POST",
  }),
  simpleProxyRoute({
    method: "POST",
    routePath: "/sessions/:id/scm-credentials",
    internalPath: SessionInternalPaths.scmCredentials,
    runtimeMethod: "POST",
  }),
  simpleProxyRoute({
    method: "GET",
    routePath: "/sessions/:id/tunnel-urls",
    internalPath: SessionInternalPaths.tunnelUrls,
    runtimeMethod: "GET",
  }),
  lifecycleProxyRoute("PATCH", "/sessions/:id/title", SessionInternalPaths.updateTitle),
  lifecycleProxyRoute("POST", "/sessions/:id/archive", SessionInternalPaths.archive),
  lifecycleProxyRoute("POST", "/sessions/:id/unarchive", SessionInternalPaths.unarchive),
];
