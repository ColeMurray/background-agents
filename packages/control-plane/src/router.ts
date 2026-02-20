/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env, CreateSessionRequest, CreateSessionResponse } from "./types";
import { generateId, encryptToken } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import {
  resolveScmProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProviderName,
} from "./source-control";
import { SessionIndexStore } from "./db/session-index";

import {
  getValidModelOrDefault,
  isValidReasoningEffort,
  type CallbackContext,
} from "@open-inspect/shared";
import { createRequestMetrics, instrumentD1 } from "./db/instrumented-d1";
import { createLogger } from "./logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  resolveInstalledRepo,
} from "./routes/shared";
import { integrationSettingsRoutes } from "./routes/integration-settings";
import { modelPreferencesRoutes } from "./routes/model-preferences";
import { reposRoutes } from "./routes/repos";
import { secretsRoutes } from "./routes/secrets";

const logger = createLogger("router");

/**
 * Create a Request to a Durable Object stub with correlation headers.
 * Ensures trace_id and request_id propagate into the DO.
 */
function internalRequest(url: string, init: RequestInit | undefined, ctx: RequestContext): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-trace-id", ctx.trace_id);
  headers.set("x-request-id", ctx.request_id);
  return new Request(url, { ...init, headers });
}

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
 * Get Durable Object stub for a session.
 * Returns the stub or null if session ID is missing.
 */
function getSessionStub(env: Env, match: RegExpMatchArray): DurableObjectStub | null {
  const sessionId = match.groups?.id;
  if (!sessionId) return null;

  const doId = env.SESSION.idFromName(sessionId);
  return env.SESSION.get(doId);
}

/**
 * Routes that do not require authentication.
 */
const PUBLIC_ROUTES: RegExp[] = [/^\/health$/];

/**
 * Routes that accept sandbox authentication.
 * These are session-specific routes that can be called by sandboxes using their auth token.
 * The sandbox token is validated by the Durable Object.
 */
const SANDBOX_AUTH_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/pr$/, // PR creation from sandbox
  /^\/sessions\/[^/]+\/openai-token-refresh$/, // OpenAI token refresh from sandbox
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

function enforceImplementedScmProvider(
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveDeploymentScmProvider(env);
    if (provider !== "github" && !isPublicRoute(path)) {
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

  // Ask the Durable Object to validate this sandbox token
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const verifyResponse = await stub.fetch(
    internalRequest(
      "http://internal/internal/verify-sandbox-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
      ctx
    )
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
  {
    method: "GET",
    pattern: parsePattern("/sessions"),
    handler: handleListSessions,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions"),
    handler: handleCreateSession,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id"),
    handler: handleGetSession,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/sessions/:id"),
    handler: handleDeleteSession,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/prompt"),
    handler: handleSessionPrompt,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/stop"),
    handler: handleSessionStop,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/events"),
    handler: handleSessionEvents,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/artifacts"),
    handler: handleSessionArtifacts,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/participants"),
    handler: handleSessionParticipants,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/participants"),
    handler: handleAddParticipant,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/messages"),
    handler: handleSessionMessages,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/pr"),
    handler: handleCreatePR,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/openai-token-refresh"),
    handler: handleOpenAITokenRefresh,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/ws-token"),
    handler: handleSessionWsToken,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/archive"),
    handler: handleArchiveSession,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/unarchive"),
    handler: handleUnarchiveSession,
  },

  // Repository management
  ...reposRoutes,

  // Secrets
  ...secretsRoutes,

  // Model preferences
  ...modelPreferencesRoutes,

  // Integration settings
  ...integrationSettingsRoutes,
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
        return error("Internal server error", 500);
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

// Session handlers

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const status = url.searchParams.get("status") || undefined;
  const excludeStatus = url.searchParams.get("excludeStatus") || undefined;

  const store = new SessionIndexStore(env.DB);
  const result = await store.list({ status, excludeStatus, limit, offset });

  return json({
    sessions: result.sessions,
    total: result.total,
    hasMore: result.hasMore,
  });
}

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as CreateSessionRequest & {
    // Optional GitHub token for PR creation (will be encrypted and stored)
    githubToken?: string;
    // User info
    userId?: string;
    githubLogin?: string;
    githubName?: string;
    githubEmail?: string;
  };

  if (!body.repoOwner || !body.repoName) {
    return error("repoOwner and repoName are required");
  }

  // Normalize repo identifiers to lowercase for consistent storage
  const repoOwner = body.repoOwner.toLowerCase();
  const repoName = body.repoName.toLowerCase();

  let repoId: number;
  try {
    const resolved = await resolveInstalledRepo(env, repoOwner, repoName);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
    repoId = resolved.repoId;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository", {
      error: message,
      repo_owner: repoOwner,
      repo_name: repoName,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  // User info from direct params
  const userId = body.userId || "anonymous";
  const githubLogin = body.githubLogin;
  const githubName = body.githubName;
  const githubEmail = body.githubEmail;
  let githubTokenEncrypted: string | null = null;

  // If GitHub token provided, encrypt it
  if (body.githubToken && env.TOKEN_ENCRYPTION_KEY) {
    try {
      githubTokenEncrypted = await encryptToken(body.githubToken, env.TOKEN_ENCRYPTION_KEY);
    } catch (e) {
      logger.error("Failed to encrypt GitHub token", {
        error: e instanceof Error ? e : String(e),
      });
      return error("Failed to process GitHub token", 500);
    }
  }

  // Generate session ID
  const sessionId = generateId();

  // Get Durable Object
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  // Validate model and reasoning effort once for both DO init and D1 index
  const model = getValidModelOrDefault(body.model);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : null;

  // Initialize session with user info and optional encrypted token
  const initResponse = await stub.fetch(
    internalRequest(
      "http://internal/internal/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName: sessionId, // Pass the session name for WebSocket routing
          repoOwner,
          repoName,
          repoId,
          title: body.title,
          model,
          reasoningEffort,
          userId,
          githubLogin,
          githubName,
          githubEmail,
          githubTokenEncrypted, // Pass encrypted token to store with owner
        }),
      },
      ctx
    )
  );

  if (!initResponse.ok) {
    return error("Failed to create session", 500);
  }

  // Store session in D1 index for listing
  const now = Date.now();
  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.create({
    id: sessionId,
    title: body.title || null,
    repoOwner,
    repoName,
    model,
    reasoningEffort,
    status: "created",
    createdAt: now,
    updatedAt: now,
  });

  const result: CreateSessionResponse = {
    sessionId,
    status: "created",
  };

  return json(result, 201);
}

async function handleGetSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest("http://internal/internal/state", undefined, ctx)
  );

  if (!response.ok) {
    return error("Session not found", 404);
  }

  return response;
}

async function handleDeleteSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  // Delete from D1 index
  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.delete(sessionId);

  // Note: Durable Object data will be garbage collected by Cloudflare
  // when no longer referenced. We could also call a cleanup method on the DO.

  return json({ status: "deleted", sessionId });
}

async function handleSessionPrompt(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    content: string;
    authorId?: string;
    source?: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: Array<{ type: string; name: string; url?: string }>;
    callbackContext?: CallbackContext;
  };

  if (!body.content) {
    return error("content is required");
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      "http://internal/internal/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: body.content,
          authorId: body.authorId || "anonymous",
          source: body.source || "web",
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          attachments: body.attachments,
          callbackContext: body.callbackContext,
        }),
      },
      ctx
    )
  );

  // Background: update D1 timestamp so session bubbles to top of sidebar
  const store = new SessionIndexStore(env.DB);
  ctx.executionCtx?.waitUntil(store.touchUpdatedAt(sessionId).catch(() => {}));

  return response;
}

async function handleSessionStop(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(internalRequest("http://internal/internal/stop", { method: "POST" }, ctx));
}

async function handleSessionEvents(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const url = new URL(request.url);
  return stub.fetch(
    internalRequest(`http://internal/internal/events${url.search}`, undefined, ctx)
  );
}

async function handleSessionArtifacts(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(internalRequest("http://internal/internal/artifacts", undefined, ctx));
}

async function handleSessionParticipants(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(internalRequest("http://internal/internal/participants", undefined, ctx));
}

async function handleAddParticipant(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = await request.json();

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      "http://internal/internal/participants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      ctx
    )
  );

  return response;
}

async function handleSessionMessages(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const url = new URL(request.url);
  return stub.fetch(
    internalRequest(`http://internal/internal/messages${url.search}`, undefined, ctx)
  );
}

async function handleCreatePR(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    title: string;
    body: string;
    baseBranch?: string;
    headBranch?: string;
  };

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

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      "http://internal/internal/create-pr",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: body.title,
          body: body.body,
          baseBranch: body.baseBranch,
          headBranch: body.headBranch,
        }),
      },
      ctx
    )
  );

  return response;
}

async function handleOpenAITokenRefresh(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(
    internalRequest("http://internal/internal/openai-token-refresh", { method: "POST" }, ctx)
  );
}

async function handleSessionWsToken(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    userId: string;
    githubUserId?: string;
    githubLogin?: string;
    githubName?: string;
    githubEmail?: string;
    githubToken?: string; // User's GitHub OAuth token for PR creation
    githubTokenExpiresAt?: number; // Token expiry timestamp in milliseconds
    githubRefreshToken?: string; // GitHub OAuth refresh token for server-side renewal
  };

  if (!body.userId) {
    return error("userId is required");
  }

  // Encrypt the GitHub tokens if provided
  const { githubTokenEncrypted, githubRefreshTokenEncrypted } = await ctx.metrics.time(
    "encrypt_tokens",
    async () => {
      let accessToken: string | null = null;
      let refreshToken: string | null = null;

      if (body.githubToken && env.TOKEN_ENCRYPTION_KEY) {
        try {
          accessToken = await encryptToken(body.githubToken, env.TOKEN_ENCRYPTION_KEY);
        } catch (e) {
          logger.error("Failed to encrypt GitHub token", {
            error: e instanceof Error ? e : String(e),
          });
          // Continue without token - PR creation will fail if this user triggers it
        }
      }

      if (body.githubRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
        try {
          refreshToken = await encryptToken(body.githubRefreshToken, env.TOKEN_ENCRYPTION_KEY);
        } catch (e) {
          logger.error("Failed to encrypt GitHub refresh token", {
            error: e instanceof Error ? e : String(e),
          });
        }
      }

      return { githubTokenEncrypted: accessToken, githubRefreshTokenEncrypted: refreshToken };
    }
  );

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await ctx.metrics.time("do_fetch", () =>
    stub.fetch(
      internalRequest(
        "http://internal/internal/ws-token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: body.userId,
            githubUserId: body.githubUserId,
            githubLogin: body.githubLogin,
            githubName: body.githubName,
            githubEmail: body.githubEmail,
            githubTokenEncrypted,
            githubRefreshTokenEncrypted,
            githubTokenExpiresAt: body.githubTokenExpiresAt,
          }),
        },
        ctx
      )
    )
  );

  return response;
}

async function handleArchiveSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  // Parse userId from request body for authorization
  let userId: string | undefined;
  try {
    const body = (await request.json()) as { userId?: string };
    userId = body.userId;
  } catch {
    // Body parsing failed, continue without userId
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      "http://internal/internal/archive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
      ctx
    )
  );

  if (response.ok) {
    // Update D1 index
    const sessionStore = new SessionIndexStore(env.DB);
    const updated = await sessionStore.updateStatus(sessionId, "archived");
    if (!updated) {
      logger.warn("Session not found in D1 index during archive", { session_id: sessionId });
    }
  }

  return response;
}

async function handleUnarchiveSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  // Parse userId from request body for authorization
  let userId: string | undefined;
  try {
    const body = (await request.json()) as { userId?: string };
    userId = body.userId;
  } catch {
    // Body parsing failed, continue without userId
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      "http://internal/internal/unarchive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
      ctx
    )
  );

  if (response.ok) {
    // Update D1 index
    const sessionStore = new SessionIndexStore(env.DB);
    const updated = await sessionStore.updateStatus(sessionId, "active");
    if (!updated) {
      logger.warn("Session not found in D1 index during unarchive", { session_id: sessionId });
    }
  }

  return response;
}
