/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env } from "./types";
import { authenticate, isAuthError } from "./auth/authenticate";
import type { Principal } from "./auth/principal";
import { getUserAuth, getUserAuthRuntime } from "./auth/user/runtime";
import {
  resolveScmProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProviderName,
} from "./source-control";
import { SessionInternalPaths } from "./session/contracts";
import { createSessionRuntimeClient } from "./session/runtime-client";

import { createRequestMetrics, instrumentD1 } from "./db/instrumented-d1";
import { UserStore } from "./db/user-store";
import { AutomationStore } from "./db/automation-store";
import { AuthorizationError, AuthorizationService } from "./authorization/service";
import { serviceAllowsPermission } from "./authorization/service-permissions";
import { SCOPED_PERMISSION_PAIRS, resolveScopedPermission } from "@open-inspect/shared/rbac";
import { createLogger } from "./logger";
import type { BackgroundTasks } from "./platform-ports";
import {
  type ActorlessServiceGrant,
  type Route,
  type RouteAuthentication,
  type RouteAuthorizationRequirement,
  type RequestContext,
  defineRoute,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  NO_AUTHORIZATION,
  parsePattern,
  requirePermission,
  json,
  error,
  HttpError,
} from "./routes/shared";
import { browserAuthRoutes } from "./routes/browser-auth";
import { signInProviderRoutes } from "./routes/sign-in-providers";
import { integrationSettingsRoutes } from "./routes/integration-settings";
import { commitSigningRoutes } from "./routes/commit-signing";
import { scmSettingsRoutes } from "./routes/scm-settings";
import { modelPreferencesRoutes } from "./routes/model-preferences";
import { reposRoutes } from "./routes/repos";
import { secretsRoutes } from "./routes/secrets";
import { environmentRoutes } from "./routes/environments";
import { environmentSecretsRoutes } from "./routes/environment-secrets";
import { imageBuildRoutes } from "./routes/image-builds";
import { automationRoutes } from "./routes/automations";
import { mcpServerRoutes } from "./routes/mcp-servers";
import { analyticsRoutes } from "./routes/analytics";
import { autofixRoutes } from "./routes/autofix";
import { skillRoutes } from "./routes/skills";
import { keyboardShortcutRoutes } from "./routes/keyboard-shortcuts";
import { rbacRoutes } from "./routes/rbac";
import { sessionRoutes } from "./routes/sessions";
import { modelProviderAccountRoutes } from "./routes/model-provider-accounts";
import { handleSlackNotify } from "./routes/slack-notify";
import { webhookRoutes } from "./webhooks";

const logger = createLogger("router");

function withCorsAndTraceHeaders(response: Response, ctx: RequestContext): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("x-request-id", ctx.request_id);
  headers.set("x-trace-id", ctx.trace_id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRouteCachePolicy(response: Response, route: Route): Response {
  if (!route.cacheControl) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", route.cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type CachedScmProvider =
  | {
      envValue: string | undefined;
      provider: SourceControlProviderName;
      error?: never;
    }
  | {
      envValue: string | undefined;
      provider?: never;
      error: SourceControlProviderError;
    };

let cachedScmProvider: CachedScmProvider | null = null;

function resolveDeploymentScmProvider(env: Env): SourceControlProviderName {
  const envValue = env.SCM_PROVIDER;
  if (!cachedScmProvider || cachedScmProvider.envValue !== envValue) {
    try {
      cachedScmProvider = {
        envValue,
        provider: resolveScmProviderFromEnv(envValue),
      };
    } catch (errorValue) {
      cachedScmProvider = {
        envValue,
        error:
          errorValue instanceof SourceControlProviderError
            ? errorValue
            : new SourceControlProviderError("Invalid SCM provider configuration", "permanent"),
      };
    }
  }

  if (cachedScmProvider.error) {
    throw cachedScmProvider.error;
  }

  return cachedScmProvider.provider;
}

function enforceImplementedScmProvider(
  route: Route,
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveDeploymentScmProvider(env);
    if (route.supportedScmProviders !== "all" && !route.supportedScmProviders.includes(provider)) {
      logger.warn("SCM provider not implemented", {
        event: "scm.provider_not_implemented",
        scm_provider: provider,
        http_path: path,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      const response = error(
        `SCM provider '${provider}' is not implemented in this deployment.`,
        501
      );
      return withCorsAndTraceHeaders(response, ctx);
    }

    return null;
  } catch (errorValue) {
    const errorMessage =
      errorValue instanceof SourceControlProviderError
        ? errorValue.message
        : "Invalid SCM provider configuration";

    logger.error("Invalid SCM provider configuration", {
      event: "scm.provider_invalid",
      error: errorValue instanceof Error ? errorValue : String(errorValue),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    const response = error(errorMessage, 500);
    return withCorsAndTraceHeaders(response, ctx);
  }
}

/**
 * Validate sandbox authentication by checking with the Durable Object.
 * The DO stores the expected sandbox auth token.
 *
 * On success, sets the sandbox principal on the request context — this is
 * the single place a sandbox principal is assembled.
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param sessionId - Session ID extracted from path
 * @param ctx - Request correlation context
 * @returns null if authentication passes, or an error Response to return immediately
 */
async function verifySandboxAuth(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return error("Unauthorized: Missing sandbox token", 401);
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  // Ask the Session runtime to validate this sandbox token.
  const verifyResponse = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.verifySandboxToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }
  );

  if (!verifyResponse.ok) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    logger.warn("Auth failed: sandbox", {
      event: "auth.sandbox_failed",
      http_path: new URL(request.url).pathname,
      client_ip: clientIP,
      session_id: sessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized: Invalid sandbox token", 401);
  }

  ctx.principal = { kind: "sandbox", sessionId };
  return null; // Auth passed
}

async function verifySandboxAuthSafely(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  try {
    return await verifySandboxAuth(request, env, sessionId, ctx);
  } catch (cause) {
    logger.error("Sandbox authentication unavailable", {
      event: "auth.sandbox_unavailable",
      session_id: sessionId,
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Sandbox authentication unavailable", 503);
  }
}

/**
 * Emit the per-request `auth.principal` line: who is acting, as a verified
 * identity — never token material.
 */
function logPrincipal(principal: Principal, ctx: RequestContext, path: string): void {
  const fields: Record<string, string | undefined> = { principal_kind: principal.kind };
  switch (principal.kind) {
    case "service":
      fields.auth_scheme = "per-service";
      fields.service = principal.service;
      fields.actor = principal.actor?.participantUserId;
      break;
    case "sandbox":
      fields.session_id = principal.sessionId;
      break;
    case "user":
      fields.user_id = principal.userId;
      break;
  }
  logger.info("auth.principal", {
    event: "auth.principal",
    ...fields,
    http_path: path,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

function logRequest(
  response: Response,
  ctx: RequestContext,
  method: string,
  path: string,
  startTime: number
): void {
  logger.info("http.request", {
    event: "http.request",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    http_method: method,
    http_path: path,
    http_status: response.status,
    duration_ms: Date.now() - startTime,
    outcome: response.status >= 500 ? "error" : "success",
    ...ctx.metrics.summarize(),
  });
}

export function enforceRoutePrincipal(
  authentication: RouteAuthentication,
  principal: Principal
): Response | null {
  if (
    authentication.kind === "web-service" &&
    (principal.kind !== "service" || principal.service !== "web")
  ) {
    return error("Unauthorized", 401);
  }
  if (authentication.kind === "user" && principal.kind !== "user") {
    return error("Human user authentication required", 403);
  }
  if (authentication.kind === "service" && principal.kind !== "service") {
    return error("Service authentication required", 403);
  }
  return null;
}

async function enforceActiveUser(route: Route, ctx: RequestContext): Promise<Response | null> {
  if (
    route.authorization.kind !== "active-user" &&
    route.authorization.kind !== "active-self" &&
    route.authorization.kind !== "active-global"
  ) {
    return null;
  }
  let resolvedServiceUserId: string | null = null;
  if (
    ctx.principal?.kind === "service" &&
    ctx.principal.actor &&
    !ctx.principal.actor.canonicalUserId
  ) {
    try {
      const user = await new UserStore(ctx.db).resolveOrCreateUser({
        provider: ctx.principal.actor.provider,
        providerUserId: ctx.principal.actor.providerUserId,
      });
      resolvedServiceUserId = user.id;
    } catch {
      return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
    }
  }
  const userId =
    ctx.principal?.kind === "user"
      ? ctx.principal.userId
      : ctx.principal?.kind === "service"
        ? (ctx.principal.actor?.canonicalUserId ?? resolvedServiceUserId)
        : null;
  if (!userId) return null;
  try {
    const authorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(userId);
    ctx.authorization = authorization;
    if (authorization.suspendedAt !== null) {
      return json({ error: "Forbidden", code: "active_user_required" }, 403);
    }
    return null;
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      return json({ error: "Forbidden", code: cause.code }, cause.status);
    }
    return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
  }
}

function authorizationUserId(ctx: RequestContext): string | null {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? ctx.authorization?.userId ?? null;
  }
  return null;
}

function actorlessGrantMatches(
  grant: ActorlessServiceGrant,
  service: string,
  match: RegExpMatchArray
): boolean {
  if (grant.service !== service) return false;
  return Object.entries(grant.pathParams ?? {}).every(([name, expected]) => {
    const value = match.groups?.[name];
    if (value === undefined) return false;
    try {
      return decodeURIComponent(value) === expected;
    } catch {
      return false;
    }
  });
}

function enforceServiceRouteAuthorization(
  route: Route,
  match: RegExpMatchArray,
  ctx: RequestContext
): Response | null {
  const principal = ctx.principal;
  const authorization = route.authorization;
  if (authorization.kind === "service") {
    if (principal?.kind !== "service") {
      return json({ error: "Forbidden", code: "service_capability_required" }, 403);
    }
    if (!authorization.services.some((service) => service === principal.service)) {
      return json({ error: "Forbidden", code: "service_capability_required" }, 403);
    }
    if (authorization.actor === "required" && !principal.actor) {
      return json({ error: "Forbidden", code: "service_actor_required" }, 403);
    }
    return null;
  }
  if (principal?.kind !== "service") return null;
  if (route.authentication.kind === "web-service" && principal.service === "web") return null;
  if (
    (authorization.kind !== "active-user" && authorization.kind !== "active-global") ||
    authorization.service.kind === "deny"
  ) {
    return json({ error: "Forbidden", code: "service_capability_required" }, 403);
  }
  if (principal.actor) return null;
  const granted = authorization.service.actorlessGrants?.some((grant) =>
    actorlessGrantMatches(grant, principal.service, match)
  );
  return granted ? null : json({ error: "Forbidden", code: "service_actor_required" }, 403);
}

async function enforcePermissionRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "permission" }>,
  ctx: RequestContext
): Promise<Response | null> {
  if (
    ctx.principal?.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, requirement.permission)
  ) {
    return json({ error: "Forbidden", code: "service_capability_required" }, 403);
  }
  const userId = authorizationUserId(ctx);
  if (!userId) return null;
  if (ctx.authorization?.permissions.includes(requirement.permission)) return null;
  return json(
    { error: "Forbidden", code: "permission_required", permission: requirement.permission },
    403
  );
}

async function enforceScopedPermissionRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "scoped-permission" }>,
  ctx: RequestContext
): Promise<Response | null> {
  const pair = SCOPED_PERMISSION_PAIRS[requirement.stem];
  if (
    ctx.principal?.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, pair.own)
  ) {
    return json({ error: "Forbidden", code: "service_capability_required" }, 403);
  }
  const userId = authorizationUserId(ctx);
  if (!userId) return null;
  if (
    ctx.authorization &&
    resolveScopedPermission(requirement.stem, ctx.authorization.permissions)
  ) {
    return null;
  }
  return json({ error: "Forbidden", code: "permission_required", permission: pair.own }, 403);
}

async function enforceAutomationRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" }>,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response | null> {
  if (ctx.principal?.kind !== "user") return null;
  const encodedAutomationId = match.groups?.[requirement.automationIdParam];
  if (!encodedAutomationId) return json({ error: "Invalid automation route" }, 400);
  let automationId: string;
  try {
    automationId = decodeURIComponent(encodedAutomationId);
  } catch {
    return json({ error: "Invalid automation route" }, 400);
  }

  try {
    const authorization = ctx.authorization;
    if (!authorization) throw new Error("Missing request authorization");
    const store = new AutomationStore(ctx.db);
    const storedAutomation = await store.getById(automationId);
    if (!storedAutomation) return error("Automation not found", 404);
    const automation = await store.resolveCanonicalOwner(storedAutomation);

    const permissionStem = `automations.${requirement.operation}` as const;
    const permissionScope = resolveScopedPermission(permissionStem, authorization.permissions);
    const ownPermission = SCOPED_PERMISSION_PAIRS[permissionStem].own;
    if (
      !permissionScope ||
      (permissionScope === "own" && automation.user_id !== ctx.principal.userId)
    ) {
      return json(
        { error: "Forbidden", code: "permission_required", permission: ownPermission },
        403
      );
    }

    ctx.automationAdmission = { automation };
    return null;
  } catch {
    return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
  }
}

async function enforceRouteAuthorization(
  route: Route,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response | null> {
  if (route.authorization.kind !== "active-user") return null;
  for (const requirement of route.authorization.allOf) {
    let authorizationError: Response | null;
    switch (requirement.kind) {
      case "permission":
        authorizationError = await enforcePermissionRequirement(requirement, ctx);
        break;
      case "scoped-permission":
        authorizationError = await enforceScopedPermissionRequirement(requirement, ctx);
        break;
      case "automation":
        authorizationError = await enforceAutomationRequirement(requirement, match, ctx);
        break;
    }
    if (authorizationError) return authorizationError;
  }
  return null;
}

/**
 * Routes definition.
 */
export const routes: Route[] = [
  // Health check
  {
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    method: "GET",
    pattern: parsePattern("/health"),
    authorization: NO_AUTHORIZATION,
    handler: async () =>
      json({
        status: "healthy",
        service: "open-inspect-control-plane",
      }),
  },

  ...browserAuthRoutes,
  ...signInProviderRoutes,

  // Session management
  ...sessionRoutes,
  // Agent-initiated Slack notification (sandbox-authenticated)
  defineRoute(GITHUB_SANDBOX_FALLBACK_ROUTE, {
    method: "POST",
    pattern: parsePattern("/sessions/:id/slack-notify"),
    authorization: requirePermission("sessions.collaborate"),
    handler: handleSlackNotify,
  }),

  // Repository management
  ...reposRoutes,

  // Secrets
  ...secretsRoutes,

  // Environments (Phase-2 session target; internal-HMAC only, web BFF proxied)
  ...environmentRoutes,
  ...environmentSecretsRoutes,

  // Image builds (scope-generic)
  ...imageBuildRoutes,

  // Model preferences
  ...modelPreferencesRoutes,

  // Subscription provider account management and sandbox access broker
  ...modelProviderAccountRoutes,

  // Integration settings
  ...integrationSettingsRoutes,

  // Deployment-wide commit signing identity
  ...commitSigningRoutes,

  // SCM (source-control) settings
  ...scmSettingsRoutes,

  // Automations
  ...automationRoutes,

  // MCP servers
  ...mcpServerRoutes,

  // Analytics
  ...analyticsRoutes,

  // Pull request feedback Autofix activity
  ...autofixRoutes,

  // Installation-wide managed skills and personal profiles
  ...skillRoutes,

  // Personal keyboard shortcuts
  ...keyboardShortcutRoutes,

  // Workspace roles, members, and current-user authorization
  ...rbacRoutes,

  // Webhooks (public routes — auth handled per-route)
  ...webhookRoutes,
];

/**
 * Match request to route and execute handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  executionCtx: BackgroundTasks
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const startTime = Date.now();

  // The DB binding is required (types.ts) and the control plane cannot serve
  // requests without it. Reject a missing binding once here — the single
  // honest boundary — so ctx.db is genuinely always present in handlers and
  // no per-route degraded-mode guards are needed.
  // eslint-disable-next-line no-restricted-syntax -- composition root: the one route-layer env.DB read
  if (!env.DB) {
    logger.error("DB binding is not configured; refusing request", { http_path: path });
    return new Response(JSON.stringify({ error: "Database not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Build correlation context with per-request metrics and the instrumented
  // database handle. Handlers use ctx.db (never env.DB) so all queries are
  // automatically timed.
  const metrics = createRequestMetrics();
  const ctx: RequestContext = {
    trace_id: request.headers.get("x-trace-id") || crypto.randomUUID(),
    request_id: crypto.randomUUID().slice(0, 8),
    metrics,
    // eslint-disable-next-line no-restricted-syntax -- composition root: the one route-layer env.DB read
    db: instrumentD1(env.DB, metrics),
    // env.DB (not the per-request instrumented wrapper) keys the memoized
    // Better Auth runtime: the canonical adapter accepts any SqlDatabase, but
    // cache identity requires the stable object.
    // eslint-disable-next-line no-restricted-syntax -- composition root: stable cache key for the auth runtime
    getUserAuth: () => getUserAuth(env, env.DB),
    // eslint-disable-next-line no-restricted-syntax -- composition root owns normalized auth runtime construction
    getUserAuthRuntime: () => getUserAuthRuntime(env, env.DB),
    executionCtx,
  };

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "x-request-id": ctx.request_id,
        "x-trace-id": ctx.trace_id,
      },
    });
  }

  const matchedRoute = routes
    .filter((route) => route.method === method)
    .map((route) => ({ route, match: path.match(route.pattern) }))
    .find(
      (candidate): candidate is { route: Route; match: RegExpMatchArray } =>
        candidate.match !== null
    );
  if (!matchedRoute) {
    return withCorsAndTraceHeaders(error("Not found", 404), ctx);
  }

  const authentication = matchedRoute.route.authentication;
  if (authentication.kind !== "public" && authentication.kind !== "handler-authenticated") {
    let authError: Response | null;

    const sandboxSessionId =
      authentication.kind === "sandbox" ||
      authentication.kind === "user-or-service-with-sandbox-fallback"
        ? authentication.getSessionId(matchedRoute.match)
        : null;

    if (authentication.kind === "sandbox") {
      authError = sandboxSessionId
        ? await verifySandboxAuthSafely(request, env, sandboxSessionId, ctx)
        : error("Unauthorized: Invalid session path", 401);
    } else {
      const authResult = await authenticate(request, env, ctx, {
        webService:
          authentication.kind === "web-service" || authentication.kind === "service"
            ? "service"
            : "user",
      });

      if (isAuthError(authResult)) {
        // A service-credential attempt is terminal; only a request with no
        // recognized credential may still be a sandbox-token call on a
        // sandbox-accepting route.
        authError = error(authResult.reason, authResult.status);

        if (
          authResult.failedScheme === "none" &&
          authentication.kind === "user-or-service-with-sandbox-fallback" &&
          sandboxSessionId
        ) {
          authError = await verifySandboxAuthSafely(request, env, sandboxSessionId, ctx);
        }
      } else {
        authError = null;
        ctx.principal = authResult.principal;
        ctx.authentication = authResult.authentication;
        request = authResult.request;
        authError = enforceRoutePrincipal(authentication, ctx.principal);
      }
    }

    if (authError) {
      if (ctx.principal) {
        logPrincipal(ctx.principal, ctx, path);
        logRequest(authError, ctx, method, path, startTime);
      }
      return withCorsAndTraceHeaders(withRouteCachePolicy(authError, matchedRoute.route), ctx);
    }

    if (ctx.principal) {
      logPrincipal(ctx.principal, ctx, path);
    }
  }

  const serviceAccessError = enforceServiceRouteAuthorization(
    matchedRoute.route,
    matchedRoute.match,
    ctx
  );
  if (serviceAccessError) {
    logRequest(serviceAccessError, ctx, method, path, startTime);
    return withCorsAndTraceHeaders(
      withRouteCachePolicy(serviceAccessError, matchedRoute.route),
      ctx
    );
  }

  const userAccessError = await enforceActiveUser(matchedRoute.route, ctx);
  if (userAccessError) {
    logRequest(userAccessError, ctx, method, path, startTime);
    return withCorsAndTraceHeaders(withRouteCachePolicy(userAccessError, matchedRoute.route), ctx);
  }

  const authorizationError = await enforceRouteAuthorization(
    matchedRoute.route,
    matchedRoute.match,
    ctx
  );
  if (authorizationError) {
    logRequest(authorizationError, ctx, method, path, startTime);
    return withCorsAndTraceHeaders(
      withRouteCachePolicy(authorizationError, matchedRoute.route),
      ctx
    );
  }

  const providerCheck = enforceImplementedScmProvider(matchedRoute.route, path, env, ctx);
  if (providerCheck) {
    return withRouteCachePolicy(providerCheck, matchedRoute.route);
  }

  let response: Response;
  try {
    response = await matchedRoute.route.handler(request, env, matchedRoute.match, ctx);
  } catch (e) {
    if (e instanceof HttpError) {
      response = error(e.message, e.status);
    } else {
      const durationMs = Date.now() - startTime;
      logger.error("http.request", {
        event: "http.request",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        http_method: method,
        http_path: path,
        http_status: 500,
        duration_ms: durationMs,
        outcome: "error",
        error: e instanceof Error ? e : String(e),
        ...ctx.metrics.summarize(),
      });
      return withCorsAndTraceHeaders(
        withRouteCachePolicy(error("Internal server error", 500), matchedRoute.route),
        ctx
      );
    }
  }

  logRequest(response, ctx, method, path, startTime);

  return withCorsAndTraceHeaders(withRouteCachePolicy(response, matchedRoute.route), ctx);
}
