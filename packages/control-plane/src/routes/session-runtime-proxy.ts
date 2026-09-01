import { readBodyCapped } from "@open-inspect/shared/http-body";
import type {
  SessionParticipantProfilesResponse,
  SessionParticipantProfile,
} from "@open-inspect/shared/types/sessions";
import {
  redactSessionSnapshotSandboxAccess,
  sessionSnapshotSchema,
} from "@open-inspect/shared/types/server-messages";
import { z } from "zod";
import { UserStore } from "../db/user-store";
import { SessionIndexStore } from "../db/session-index";
import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import { SessionInternalPaths, type SessionInternalPath } from "../session/contracts";
import type { Env } from "../types";
import {
  defineRoute,
  error,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  GITHUB_USER_OR_SERVICE_ROUTE,
  NO_AUTHORIZATION,
  parseJsonBody,
  parsePattern,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_CREDENTIALS_ROUTE,
  type Route,
  type RouteAuthorization,
  type RoutePolicy,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const participantsResponseSchema = z.object({
  participants: z.array(
    z.object({
      userId: z.string(),
      canonicalUserId: z.string().nullable().optional(),
    })
  ),
});

const SANDBOX_ERROR_BODY_MAX_BYTES = 2 * 1024;

type SimpleProxyRouteConfig = {
  policy: RoutePolicy;
  method: string;
  routePath: string;
  internalPath: SessionInternalPath;
  authorization: RouteAuthorization;
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
  return defineRoute(
    config.policy,
    sessionRoute({
      method: config.method,
      pattern: parsePattern(config.routePath),
      authorization: config.authorization,
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
    })
  );
}

function legacyTokenRefreshRoute(
  provider: SubscriptionProviderId,
  routePath: string,
  internalPath: SessionInternalPath
): Route {
  return defineRoute(
    SCM_AGNOSTIC_SANDBOX_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern(routePath),
      authorization: NO_AUTHORIZATION,
      handler: async (_request, _env, match, ctx) => {
        const sessionId = getSessionId(match);
        if (sessionId instanceof Response) return sessionId;
        const binding = await new SessionIndexStore(ctx.db).getProviderAuthForProvider(
          sessionId,
          provider
        );
        if (binding?.authMode !== "legacy_scoped_oauth") {
          return error("Session does not use legacy scoped OAuth for this provider", 409);
        }
        return ctx.sessionRuntime.fetch(sessionId, internalPath, { method: "POST" });
      },
    })
  );
}

async function handleSandboxError(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = getSessionId(match);
  if (sessionId instanceof Response) return sessionId;
  const authorization = request.headers.get("Authorization");
  const sandboxId = request.headers.get("X-Sandbox-ID");
  if (!authorization?.startsWith("Bearer ") || !sandboxId) {
    return error("Unauthorized", 401);
  }
  const body = await readBodyCapped(request.body, SANDBOX_ERROR_BODY_MAX_BYTES);
  if (body === null) return error("Sandbox error body is too large", 413);
  if (body.byteLength === 0) return error("Sandbox error body is required", 400);

  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.sandboxError, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "X-Sandbox-ID": sandboxId,
    },
    body,
  });
}

async function handleParticipantProfiles(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = getSessionId(match);
  if (sessionId instanceof Response) return sessionId;

  const participantsResponse = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.participants
  );
  if (!participantsResponse.ok) return participantsResponse;

  const parsed = participantsResponseSchema.safeParse(
    await participantsResponse.json().catch(() => null)
  );
  if (!parsed.success) return error("Invalid participant response", 502);
  const participants = parsed.data.participants;

  const users = await new UserStore(ctx.db).getUsersByIds(
    participants.map((participant) => participant.canonicalUserId ?? participant.userId)
  );
  const profiles = Object.fromEntries(
    users.map((user): [string, SessionParticipantProfile] => [
      user.id,
      {
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
    ])
  );
  return Response.json({ profiles } satisfies SessionParticipantProfilesResponse);
}

async function handleSessionSnapshot(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = getSessionId(match);
  if (sessionId instanceof Response) return sessionId;

  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.snapshot);
  if (response.status === 404) return error("Session not found", 404);
  if (!response.ok) return response;

  const parsed = sessionSnapshotSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return error("Invalid session snapshot", 502);
  const snapshot = ctx.authorization?.permissions.includes("sessions.sandbox_access")
    ? parsed.data
    : redactSessionSnapshotSandboxAccess(parsed.data);
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json(snapshot, { headers });
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

  if (body.draft !== undefined && typeof body.draft !== "boolean") {
    return error("draft must be a boolean");
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
      draft: body.draft,
    }),
  });
}

/**
 * Title updates accept a bodyless request but reject caller-supplied identity.
 */
async function readTitleBody(request: Request): Promise<{ title?: string; rejection?: Response }> {
  let body: { title?: string } = {};
  try {
    const parsed: unknown = await request.json();
    if (isObjectBody(parsed)) {
      if ("userId" in parsed) {
        return { rejection: error("Field 'userId' is not accepted from verified callers", 400) };
      }
      body = parsed;
    }
  } catch {
    // Body parsing failed, continue without fields.
  }
  return { title: body.title };
}

function lifecycleProxyRoute(
  method: string,
  routePath: string,
  internalPath: SessionInternalPath
): Route {
  return defineRoute(
    GITHUB_USER_OR_SERVICE_ROUTE,
    sessionRoute({
      method,
      pattern: parsePattern(routePath),
      authorization: requirePermission("sessions.lifecycle"),
      handler: async (request, _env, match, ctx) => {
        const sessionId = getSessionId(match);
        if (sessionId instanceof Response) return sessionId;

        let body = {};
        if (internalPath === SessionInternalPaths.updateTitle) {
          const { title, rejection } = await readTitleBody(request);
          if (rejection) return rejection;
          body = { title };
        }

        return ctx.sessionRuntime.fetch(sessionId, internalPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      },
    })
  );
}

export const sessionRuntimeProxyRoutes: Route[] = [
  simpleProxyRoute({
    policy: SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/sandbox-access",
    internalPath: SessionInternalPaths.sandboxAccess,
    authorization: requirePermission("sessions.sandbox_access"),
  }),
  defineRoute(
    SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    sessionRoute({
      method: "GET",
      pattern: parsePattern("/sessions/:id"),
      authorization: requirePermission("sessions.read"),
      handler: handleSessionSnapshot,
    })
  ),
  simpleProxyRoute({
    policy: GITHUB_USER_OR_SERVICE_ROUTE,
    method: "POST",
    routePath: "/sessions/:id/stop",
    internalPath: SessionInternalPaths.stop,
    authorization: requirePermission("sessions.lifecycle", {
      actorlessGrants: [{ service: "linear-bot" }],
    }),
    runtimeMethod: "POST",
  }),
  defineRoute(
    SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern("/sessions/:id/sandbox-error"),
      authorization: NO_AUTHORIZATION,
      handler: handleSandboxError,
    })
  ),
  simpleProxyRoute({
    policy: GITHUB_USER_OR_SERVICE_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/events",
    internalPath: SessionInternalPaths.events,
    authorization: requirePermission("sessions.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
    forwardSearch: true,
  }),
  simpleProxyRoute({
    policy: GITHUB_USER_OR_SERVICE_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/artifacts",
    internalPath: SessionInternalPaths.artifacts,
    authorization: requirePermission("sessions.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
  }),
  simpleProxyRoute({
    policy: GITHUB_USER_OR_SERVICE_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/participants",
    internalPath: SessionInternalPaths.participants,
    authorization: requirePermission("sessions.read"),
  }),
  defineRoute(
    SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    sessionRoute({
      method: "GET",
      pattern: parsePattern("/sessions/:id/participant-profiles"),
      authorization: requirePermission("sessions.read"),
      handler: handleParticipantProfiles,
    })
  ),
  simpleProxyRoute({
    policy: GITHUB_USER_OR_SERVICE_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/messages",
    internalPath: SessionInternalPaths.messages,
    authorization: requirePermission("sessions.read"),
    forwardSearch: true,
  }),
  defineRoute(
    GITHUB_SANDBOX_FALLBACK_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern("/sessions/:id/pr"),
      authorization: requirePermission("sessions.collaborate"),
      handler: handleCreatePR,
    })
  ),
  legacyTokenRefreshRoute(
    "openai",
    "/sessions/:id/openai-token-refresh",
    SessionInternalPaths.openaiTokenRefresh
  ),
  legacyTokenRefreshRoute(
    "xai",
    "/sessions/:id/xai-token-refresh",
    SessionInternalPaths.xaiTokenRefresh
  ),
  simpleProxyRoute({
    policy: SCM_CREDENTIALS_ROUTE,
    method: "POST",
    routePath: "/sessions/:id/scm-credentials",
    internalPath: SessionInternalPaths.scmCredentials,
    authorization: NO_AUTHORIZATION,
    runtimeMethod: "POST",
  }),
  simpleProxyRoute({
    policy: SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
    method: "GET",
    routePath: "/sessions/:id/tunnel-urls",
    internalPath: SessionInternalPaths.tunnelUrls,
    authorization: requirePermission("sessions.sandbox_access"),
    runtimeMethod: "GET",
  }),
  lifecycleProxyRoute("PATCH", "/sessions/:id/title", SessionInternalPaths.updateTitle),
  lifecycleProxyRoute("POST", "/sessions/:id/archive", SessionInternalPaths.archive),
  lifecycleProxyRoute("POST", "/sessions/:id/unarchive", SessionInternalPaths.unarchive),
];
