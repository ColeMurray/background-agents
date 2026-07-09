/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env } from "./types";
import { verifyInternalToken } from "./auth/internal";
import {
  resolveScmProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProviderName,
} from "./source-control";
import { SessionInternalPaths } from "./session/contracts";
import { createSessionRuntimeClient } from "./session/runtime-client";

import { createRequestMetrics, instrumentD1 } from "./db/instrumented-d1";
import { createLogger } from "./logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  HttpError,
} from "./routes/shared";
import { integrationSettingsRoutes } from "./routes/integration-settings";
import { modelPreferencesRoutes } from "./routes/model-preferences";
import { reposRoutes } from "./routes/repos";
import { repoImageRoutes } from "./routes/repo-images";
import { secretsRoutes } from "./routes/secrets";
import { environmentRoutes } from "./routes/environments";
import { environmentSecretsRoutes } from "./routes/environment-secrets";
import { environmentImageRoutes } from "./routes/environment-images";
import { automationRoutes } from "./routes/automations";
import { mcpServerRoutes } from "./routes/mcp-servers";
import { analyticsRoutes } from "./routes/analytics";
import { providerIdentityRoutes } from "./routes/provider-identities";
import { sessionRoutes } from "./routes/sessions";
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

/**
 * Routes that do not require authentication.
 */
const PUBLIC_ROUTES: RegExp[] = [
  /^\/health$/,
  /^\/webhooks\/sentry\/[^/]+$/,
  /^\/webhooks\/automation\/[^/]+$/,
  /^\/repo-images\/build-complete$/,
  /^\/repo-images\/build-failed$/,
  // Environment-image callbacks authenticate inside the workflow (internal
  // HMAC for provider_image mode), same as the repo-image callbacks above.
  /^\/environment-images\/build-complete$/,
  /^\/environment-images\/build-failed$/,
];

/**
 * Routes that accept sandbox authentication.
 * These are session-specific routes that can be called by sandboxes using their auth token.
 * The sandbox token is validated by the Durable Object.
 */
const SANDBOX_AUTH_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/pr$/, // PR creation from sandbox
  /^\/sessions\/[^/]+\/openai-token-refresh$/, // OpenAI token refresh from sandbox
  /^\/sessions\/[^/]+\/scm-credentials$/, // SCM credential broker for git credential helper
  /^\/sessions\/[^/]+\/tunnel-urls$/, // Tunnel URL fetch for sandboxes whose .tunnels.env write isn't visible from inside
  /^\/sessions\/[^/]+\/media$/, // Media upload from sandbox
  /^\/sessions\/[^/]+\/children$/, // POST spawn, GET list
  /^\/sessions\/[^/]+\/children\/[^/]+$/, // GET child detail
  /^\/sessions\/[^/]+\/children\/[^/]+\/cancel$/, // POST cancel child
  /^\/sessions\/[^/]+\/slack-notify$/, // Agent-initiated Slack notification
];

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

/**
 * Check if a path matches any public route pattern.
 */
function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some((pattern) => pattern.test(path));
}

/**
 * Check if a path matches any sandbox auth route pattern.
 */
function isSandboxAuthRoute(path: string): boolean {
  return SANDBOX_AUTH_ROUTES.some((pattern) => pattern.test(path));
}

function isScmAgnosticRoute(path: string): boolean {
  return (
    /^\/analytics\/(summary|timeseries|breakdown)$/.test(path) ||
    // Identity upserts are independent of the SCM provider. Only the known auth
    // providers are agnostic; an unimplemented SCM (e.g. gitlab) still 501s.
    /^\/provider-identities\/(github|slack|linear|google)\/[^/]+$/.test(path) ||
    /^\/sessions\/[^/]+\/tunnel-urls$/.test(path)
  );
}

function isProviderImplementedRoute(provider: SourceControlProviderName, path: string): boolean {
  if (provider === "github") return true;
  return provider === "gitlab" && /^\/sessions\/[^/]+\/scm-credentials$/.test(path);
}

function enforceImplementedScmProvider(
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveDeploymentScmProvider(env);
    if (
      !isProviderImplementedRoute(provider, path) &&
      !isPublicRoute(path) &&
      !isScmAgnosticRoute(path)
    ) {
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

  return null; // Auth passed
}

/**
 * Require internal API authentication for service-to-service calls.
 * Fails closed: returns error response if secret is not configured or token is invalid.
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param path - Request path for logging
 * @param ctx - Request correlation context
 * @returns null if authentication passes, or an error Response to return immediately
 */
async function requireInternalAuth(
  request: Request,
  env: Env,
  path: string,
  ctx: RequestContext
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    logger.error("INTERNAL_CALLBACK_SECRET not configured - rejecting request", {
      event: "auth.misconfigured",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Internal authentication not configured", 500);
  }

  const isValid = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!isValid) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    logger.warn("Auth failed: HMAC", {
      event: "auth.hmac_failed",
      http_path: path,
      client_ip: clientIP,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  return null; // Auth passed
}

/**
 * Routes definition.
 */
const routes: Route[] = [
  // Health check
  {
    method: "GET",
    pattern: parsePattern("/health"),
    handler: async () => json({ status: "healthy", service: "open-inspect-control-plane" }),
  },

  // Session management
  ...sessionRoutes,
  // Agent-initiated Slack notification (sandbox-authenticated)
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/slack-notify"),
    handler: handleSlackNotify,
  },

  // Repository management
  ...reposRoutes,

  // Secrets
  ...secretsRoutes,

  // Environments (Phase-2 session target; internal-HMAC only, web BFF proxied)
  ...environmentRoutes,
  ...environmentSecretsRoutes,
  ...environmentImageRoutes,

  // Model preferences
  ...modelPreferencesRoutes,

  // Integration settings
  ...integrationSettingsRoutes,

  // Repo image builds
  ...repoImageRoutes,

  // Automations
  ...automationRoutes,

  // MCP servers
  ...mcpServerRoutes,

  // Analytics
  ...analyticsRoutes,

  // Provider identities
  ...providerIdentityRoutes,

  // Webhooks (public routes — auth handled per-route)
  ...webhookRoutes,
];

/**
 * Match request to route and execute handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  executionCtx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const startTime = Date.now();

  // Build correlation context with per-request metrics
  const metrics = createRequestMetrics();
  const ctx: RequestContext = {
    trace_id: request.headers.get("x-trace-id") || crypto.randomUUID(),
    request_id: crypto.randomUUID().slice(0, 8),
    metrics,
    executionCtx,
  };

  // Instrument D1 so all queries are automatically timed
  const instrumentedEnv: Env = { ...env, DB: instrumentD1(env.DB, metrics) };

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "x-request-id": ctx.request_id,
        "x-trace-id": ctx.trace_id,
      },
    });
  }

  // Require authentication for non-public routes
  if (!isPublicRoute(path)) {
    // First try HMAC auth (for web app, slack bot, etc.)
    const hmacAuthError = await requireInternalAuth(request, env, path, ctx);

    if (hmacAuthError) {
      // HMAC auth failed - check if this route accepts sandbox auth
      if (isSandboxAuthRoute(path)) {
        // Extract session ID from path (e.g., /sessions/abc123/pr -> abc123)
        const sessionIdMatch = path.match(/^\/sessions\/([^/]+)\//);
        if (sessionIdMatch) {
          const sessionId = sessionIdMatch[1];
          const sandboxAuthError = await verifySandboxAuth(request, env, sessionId, ctx);
          if (!sandboxAuthError) {
            // Sandbox auth passed, continue to route handler
          } else {
            // Both HMAC and sandbox auth failed
            return withCorsAndTraceHeaders(sandboxAuthError, ctx);
          }
        }
      } else {
        // Not a sandbox auth route, return HMAC auth error
        return withCorsAndTraceHeaders(hmacAuthError, ctx);
      }
    }
  }

  const providerCheck = enforceImplementedScmProvider(path, env, ctx);
  if (providerCheck) {
    return providerCheck;
  }

  // Find matching route
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = path.match(route.pattern);
    if (match) {
      let response: Response;
      let outcome: "success" | "error";
      try {
        response = await route.handler(request, instrumentedEnv, match, ctx);
        outcome = response.status >= 500 ? "error" : "success";
      } catch (e) {
        if (e instanceof HttpError) {
          response = error(e.message, e.status);
          outcome = e.status >= 500 ? "error" : "success";
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
          return withCorsAndTraceHeaders(error("Internal server error", 500), ctx);
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info("http.request", {
        event: "http.request",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        http_method: method,
        http_path: path,
        http_status: response.status,
        duration_ms: durationMs,
        outcome,
        ...ctx.metrics.summarize(),
      });

      return withCorsAndTraceHeaders(response, ctx);
    }
  }

  return error("Not found", 404);
}
