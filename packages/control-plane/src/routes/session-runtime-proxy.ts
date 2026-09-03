import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
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
  error,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  GITHUB_USER_OR_SERVICE_ROUTE,
  NO_AUTHORIZATION,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_CREDENTIALS_ROUTE,
} from "./shared";
import { parseJsonBody } from "./body";
import { type SessionRouteContext, dispatchSession } from "./session-route";

const participantsResponseSchema = z.object({
  participants: z.array(
    z.object({
      userId: z.string(),
      canonicalUserId: z.string().nullable().optional(),
    })
  ),
});

const SANDBOX_ERROR_BODY_MAX_BYTES = 2 * 1024;

type SessionParams = { id: string };
type ProxyHandler = (
  request: Request,
  env: Env,
  params: SessionParams,
  ctx: SessionRouteContext
) => Promise<Response>;

type SimpleProxyConfig = {
  internalPath: SessionInternalPath;
  runtimeMethod?: string;
  forwardSearch?: boolean;
  notFoundMessage?: string;
};

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Forward the request to one internal session path and relay the runtime's answer. */
function simpleProxy(config: SimpleProxyConfig): ProxyHandler {
  return async (request, _env, params, ctx) => {
    const response = await ctx.sessionRuntime.fetch(
      params.id,
      config.internalPath,
      config.runtimeMethod ? { method: config.runtimeMethod } : undefined,
      config.forwardSearch ? new URL(request.url).search : undefined
    );

    if (config.notFoundMessage && response.status === 404) {
      return error(config.notFoundMessage, 404);
    }

    return response;
  };
}

function legacyTokenRefresh(
  provider: SubscriptionProviderId,
  internalPath: SessionInternalPath
): ProxyHandler {
  return async (_request, _env, params, ctx) => {
    const binding = await new SessionIndexStore(ctx.db).getProviderAuthForProvider(
      params.id,
      provider
    );
    if (binding?.authMode !== "legacy_scoped_oauth") {
      return error("Session does not use legacy scoped OAuth for this provider", 409);
    }
    return ctx.sessionRuntime.fetch(params.id, internalPath, { method: "POST" });
  };
}

async function handleSandboxError(
  request: Request,
  _env: Env,
  params: SessionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
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
  params: SessionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

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
  params: SessionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

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
  params: SessionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

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

function lifecycleProxy(internalPath: SessionInternalPath): ProxyHandler {
  return async (request, _env, params, ctx) => {
    let body = {};
    if (internalPath === SessionInternalPaths.updateTitle) {
      const { title, rejection } = await readTitleBody(request);
      if (rejection) return rejection;
      body = { title };
    }

    return ctx.sessionRuntime.fetch(params.id, internalPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };
}

/** Every proxied session operation, by the name its route is known by. */
const LIFECYCLE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.lifecycle"),
});

export const sessionRuntimeProxyRoutes = new Hono<ControlPlaneHonoEnv>();

sessionRuntimeProxyRoutes.get(
  "/sessions/:id/sandbox-access",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("sessions.sandbox_access"),
  }),
  (c) => dispatchSession(c, simpleProxy({ internalPath: SessionInternalPaths.sandboxAccess }))
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatchSession(c, handleSessionSnapshot)
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/stop",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.lifecycle", {
      actorlessGrants: [{ service: "linear-bot" }],
    }),
  }),
  (c) =>
    dispatchSession(
      c,
      simpleProxy({ internalPath: SessionInternalPaths.stop, runtimeMethod: "POST" })
    )
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/sandbox-error",
  admit({ ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatchSession(c, handleSandboxError)
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/events",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
  }),
  (c) =>
    dispatchSession(
      c,
      simpleProxy({ internalPath: SessionInternalPaths.events, forwardSearch: true })
    )
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/artifacts",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
  }),
  (c) => dispatchSession(c, simpleProxy({ internalPath: SessionInternalPaths.artifacts }))
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/participants",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) => dispatchSession(c, simpleProxy({ internalPath: SessionInternalPaths.participants }))
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/participant-profiles",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read"),
  }),
  (c) => dispatchSession(c, handleParticipantProfiles)
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/messages",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requirePermission("sessions.read") }),
  (c) =>
    dispatchSession(
      c,
      simpleProxy({ internalPath: SessionInternalPaths.messages, forwardSearch: true })
    )
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/pr",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requirePermission("sessions.collaborate"),
  }),
  (c) => dispatchSession(c, handleCreatePR)
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/openai-token-refresh",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatchSession(c, legacyTokenRefresh("openai", SessionInternalPaths.openaiTokenRefresh))
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/xai-token-refresh",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatchSession(c, legacyTokenRefresh("xai", SessionInternalPaths.xaiTokenRefresh))
);
sessionRuntimeProxyRoutes.post(
  "/sessions/:id/scm-credentials",
  admit({ ...SCM_CREDENTIALS_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) =>
    dispatchSession(
      c,
      simpleProxy({ internalPath: SessionInternalPaths.scmCredentials, runtimeMethod: "POST" })
    )
);
sessionRuntimeProxyRoutes.get(
  "/sessions/:id/tunnel-urls",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
    authorization: requirePermission("sessions.sandbox_access"),
  }),
  (c) =>
    dispatchSession(
      c,
      simpleProxy({ internalPath: SessionInternalPaths.tunnelUrls, runtimeMethod: "GET" })
    )
);
sessionRuntimeProxyRoutes.patch("/sessions/:id/title", LIFECYCLE, (c) =>
  dispatchSession(c, lifecycleProxy(SessionInternalPaths.updateTitle))
);
sessionRuntimeProxyRoutes.post("/sessions/:id/archive", LIFECYCLE, (c) =>
  dispatchSession(c, lifecycleProxy(SessionInternalPaths.archive))
);
sessionRuntimeProxyRoutes.post("/sessions/:id/unarchive", LIFECYCLE, (c) =>
  dispatchSession(c, lifecycleProxy(SessionInternalPaths.unarchive))
);
