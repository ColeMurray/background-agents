/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env, CreateSessionRequest, CreateSessionResponse } from "./types";
import { generateId, encryptToken } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import {
  getGitHubAppConfig,
  getInstallationRepository,
  listInstallationRepositories,
} from "./auth/github-app";
import { RepoSecretsStore, RepoSecretsValidationError } from "./db/repo-secrets";
import type {
  EnrichedRepository,
  InstallationRepository,
  RepoMetadata,
} from "@open-inspect/shared";
import { getRepoMetadataKey } from "./utils/repo";
import { createLogger } from "./logger";
import type { CorrelationContext } from "./logger";

const logger = createLogger("router");

/**
 * Request context with correlation IDs propagated to downstream services.
 */
export type RequestContext = CorrelationContext;

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

/**
 * Route configuration.
 */
interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    request: Request,
    env: Env,
    match: RegExpMatchArray,
    ctx: RequestContext
  ) => Promise<Response>;
}

/**
 * Parse route pattern into regex.
 */
function parsePattern(pattern: string): RegExp {
  const regexPattern = pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp(`^${regexPattern}$`);
}

/**
 * Create JSON response.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create error response.
 */
function error(message: string, status = 400): Response {
  return json({ error: message }, status);
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
];

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
  {
    method: "GET",
    pattern: parsePattern("/repos"),
    handler: handleListRepos,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/metadata"),
    handler: handleUpdateRepoMetadata,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/metadata"),
    handler: handleGetRepoMetadata,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleSetRepoSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleListRepoSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:owner/:name/secrets/:key"),
    handler: handleDeleteRepoSecret,
  },
];

/**
 * Match request to route and execute handler.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const startTime = Date.now();

  // Build correlation context
  const ctx: RequestContext = {
    trace_id: request.headers.get("x-trace-id") || crypto.randomUUID(),
    request_id: crypto.randomUUID().slice(0, 8),
  };

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
            const corsHeaders = new Headers(sandboxAuthError.headers);
            corsHeaders.set("Access-Control-Allow-Origin", "*");
            corsHeaders.set("x-request-id", ctx.request_id);
            corsHeaders.set("x-trace-id", ctx.trace_id);
            return new Response(sandboxAuthError.body, {
              status: sandboxAuthError.status,
              statusText: sandboxAuthError.statusText,
              headers: corsHeaders,
            });
          }
        }
      } else {
        // Not a sandbox auth route, return HMAC auth error
        const corsHeaders = new Headers(hmacAuthError.headers);
        corsHeaders.set("Access-Control-Allow-Origin", "*");
        corsHeaders.set("x-request-id", ctx.request_id);
        corsHeaders.set("x-trace-id", ctx.trace_id);
        return new Response(hmacAuthError.body, {
          status: hmacAuthError.status,
          statusText: hmacAuthError.statusText,
          headers: corsHeaders,
        });
      }
    }
  }

  // Find matching route
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = path.match(route.pattern);
    if (match) {
      let response: Response;
      let outcome: "success" | "error";
      try {
        response = await route.handler(request, env, match, ctx);
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
        });
        return error("Internal server error", 500);
      }

      // Create new response with CORS + correlation headers
      const corsHeaders = new Headers(response.headers);
      corsHeaders.set("Access-Control-Allow-Origin", "*");
      corsHeaders.set("x-request-id", ctx.request_id);
      corsHeaders.set("x-trace-id", ctx.trace_id);

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
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: corsHeaders,
      });
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
  const cursor = url.searchParams.get("cursor") || undefined;

  // List sessions from KV index
  const listResult = await env.SESSION_INDEX.list({
    prefix: "session:",
    limit,
    cursor,
  });

  // Fetch session data for each key
  const sessions = await Promise.all(
    listResult.keys.map(async (key) => {
      const data = await env.SESSION_INDEX.get(key.name, "json");
      return data;
    })
  );

  return json({
    sessions: sessions.filter(Boolean),
    cursor: listResult.list_complete ? undefined : listResult.cursor,
    hasMore: !listResult.list_complete,
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
          model: body.model || "claude-haiku-4-5", // Default to haiku for cost efficiency
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

  // Store session in KV index for listing
  const now = Date.now();
  await env.SESSION_INDEX.put(
    `session:${sessionId}`,
    JSON.stringify({
      id: sessionId,
      title: body.title || null,
      repoOwner,
      repoName,
      model: body.model || "claude-haiku-4-5",
      status: "created",
      createdAt: now,
      updatedAt: now,
    })
  );

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

  // Delete from KV index
  await env.SESSION_INDEX.delete(`session:${sessionId}`);

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
    attachments?: Array<{ type: string; name: string; url?: string }>;
    callbackContext?: {
      channel: string;
      threadTs: string;
      repoFullName: string;
      model: string;
    };
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
          attachments: body.attachments,
          callbackContext: body.callbackContext,
        }),
      },
      ctx
    )
  );

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
  };

  if (!body.title || !body.body) {
    return error("title and body are required");
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
        }),
      },
      ctx
    )
  );

  return response;
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

  // Encrypt the GitHub token if provided
  let githubTokenEncrypted: string | null = null;
  if (body.githubToken && env.TOKEN_ENCRYPTION_KEY) {
    try {
      githubTokenEncrypted = await encryptToken(body.githubToken, env.TOKEN_ENCRYPTION_KEY);
    } catch (e) {
      logger.error("Failed to encrypt GitHub token", {
        error: e instanceof Error ? e : String(e),
      });
      // Continue without token - PR creation will fail if this user triggers it
    }
  }

  // Encrypt the GitHub refresh token if provided
  let githubRefreshTokenEncrypted: string | null = null;
  if (body.githubRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    try {
      githubRefreshTokenEncrypted = await encryptToken(
        body.githubRefreshToken,
        env.TOKEN_ENCRYPTION_KEY
      );
    } catch (e) {
      logger.error("Failed to encrypt GitHub refresh token", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
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
    // Update KV index
    const sessionData = (await env.SESSION_INDEX.get(`session:${sessionId}`, "json")) as Record<
      string,
      unknown
    > | null;
    if (sessionData) {
      await env.SESSION_INDEX.put(
        `session:${sessionId}`,
        JSON.stringify({
          ...sessionData,
          status: "archived",
          updatedAt: Date.now(),
        })
      );
    } else {
      logger.warn("Session not found in KV index during archive", { session_id: sessionId });
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
    // Update KV index
    const sessionData = (await env.SESSION_INDEX.get(`session:${sessionId}`, "json")) as Record<
      string,
      unknown
    > | null;
    if (sessionData) {
      await env.SESSION_INDEX.put(
        `session:${sessionId}`,
        JSON.stringify({
          ...sessionData,
          status: "active",
          updatedAt: Date.now(),
        })
      );
    } else {
      logger.warn("Session not found in KV index during unarchive", { session_id: sessionId });
    }
  }

  return response;
}

// Repository handlers

async function resolveInstalledRepo(
  env: Env,
  repoOwner: string,
  repoName: string
): Promise<{ repoId: number; repoOwner: string; repoName: string } | null> {
  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) {
    throw new Error("GitHub App not configured");
  }

  const repo = await getInstallationRepository(appConfig, repoOwner, repoName);
  if (!repo) {
    return null;
  }

  return {
    repoId: repo.id,
    repoOwner: repoOwner.toLowerCase(),
    repoName: repoName.toLowerCase(),
  };
}

/**
 * Cached repos list structure.
 */
interface CachedReposList {
  repos: EnrichedRepository[];
  cachedAt: string;
}

/**
 * List all repositories accessible via the GitHub App installation.
 * Results are cached in KV for 5 minutes to avoid rate limits.
 */
async function handleListRepos(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const CACHE_KEY = "repos:list";
  const CACHE_TTL = 300; // 5 minutes

  // Check KV cache first
  try {
    const cached = (await env.SESSION_INDEX.get(CACHE_KEY, "json")) as CachedReposList | null;
    if (cached) {
      return json({
        repos: cached.repos,
        cached: true,
        cachedAt: cached.cachedAt,
      });
    }
  } catch (e) {
    logger.warn("Failed to read repos cache", { error: e instanceof Error ? e : String(e) });
  }

  // Get GitHub App config
  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) {
    return error("GitHub App not configured", 500);
  }

  // Fetch repositories from GitHub App installation
  let repos: InstallationRepository[];
  try {
    repos = await listInstallationRepositories(appConfig);
  } catch (e) {
    logger.error("Failed to list installation repositories", {
      error: e instanceof Error ? e : String(e),
    });
    return error("Failed to fetch repositories from GitHub", 500);
  }

  // Enrich repos with stored metadata
  const enrichedRepos: EnrichedRepository[] = await Promise.all(
    repos.map(async (repo) => {
      const newKey = getRepoMetadataKey(repo.owner, repo.name);
      const oldKey = `repo:metadata:${repo.fullName}`; // Original casing for migration

      try {
        let metadata = (await env.SESSION_INDEX.get(newKey, "json")) as RepoMetadata | null;

        // Migration: check old key pattern if metadata not found at new key
        if (!metadata && repo.fullName.toLowerCase() !== newKey.replace("repo:metadata:", "")) {
          metadata = (await env.SESSION_INDEX.get(oldKey, "json")) as RepoMetadata | null;
          if (metadata) {
            // Migrate to new key
            await env.SESSION_INDEX.put(newKey, JSON.stringify(metadata));
            await env.SESSION_INDEX.delete(oldKey);
            logger.info("Migrated repo metadata key", { old_key: oldKey, new_key: newKey });
          }
        }

        return metadata ? { ...repo, metadata } : repo;
      } catch {
        return repo;
      }
    })
  );

  // Cache the results
  const cachedAt = new Date().toISOString();
  const cacheData: CachedReposList = {
    repos: enrichedRepos,
    cachedAt,
  };

  try {
    await env.SESSION_INDEX.put(CACHE_KEY, JSON.stringify(cacheData), {
      expirationTtl: CACHE_TTL,
    });
  } catch (e) {
    logger.warn("Failed to cache repos list", { error: e instanceof Error ? e : String(e) });
  }

  return json({
    repos: enrichedRepos,
    cached: false,
    cachedAt,
  });
}

/**
 * Update metadata for a specific repository.
 * This allows storing custom descriptions, aliases, and channel associations.
 */
async function handleUpdateRepoMetadata(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const owner = match.groups?.owner;
  const name = match.groups?.name;

  if (!owner || !name) {
    return error("Owner and name are required");
  }

  const body = (await request.json()) as RepoMetadata;

  // Validate and clean the metadata structure (remove undefined fields)
  const metadata = Object.fromEntries(
    Object.entries({
      description: body.description,
      aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      channelAssociations: Array.isArray(body.channelAssociations)
        ? body.channelAssociations
        : undefined,
      keywords: Array.isArray(body.keywords) ? body.keywords : undefined,
    }).filter(([, v]) => v !== undefined)
  ) as RepoMetadata;

  const metadataKey = getRepoMetadataKey(owner, name);

  try {
    await env.SESSION_INDEX.put(metadataKey, JSON.stringify(metadata));

    // Invalidate the repos cache so next fetch includes updated metadata
    await env.SESSION_INDEX.delete("repos:list");

    // Return normalized repo identifier
    const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return json({
      status: "updated",
      repo: normalizedRepo,
      metadata,
    });
  } catch (e) {
    logger.error("Failed to update repo metadata", {
      error: e instanceof Error ? e : String(e),
    });
    return error("Failed to update metadata", 500);
  }
}

/**
 * Get metadata for a specific repository.
 */
async function handleGetRepoMetadata(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const owner = match.groups?.owner;
  const name = match.groups?.name;

  if (!owner || !name) {
    return error("Owner and name are required");
  }

  const metadataKey = getRepoMetadataKey(owner, name);
  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;

  try {
    const metadata = (await env.SESSION_INDEX.get(metadataKey, "json")) as RepoMetadata | null;

    if (!metadata) {
      return json({
        repo: normalizedRepo,
        metadata: null,
      });
    }

    return json({
      repo: normalizedRepo,
      metadata,
    });
  } catch (e) {
    logger.error("Failed to get repo metadata", { error: e instanceof Error ? e : String(e) });
    return error("Failed to get metadata", 500);
  }
}

/**
 * Upsert secrets for a repository.
 */
async function handleSetRepoSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  let body: { secrets?: Record<string, string> };
  try {
    body = (await request.json()) as { secrets?: Record<string, string> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const result = await store.setSecrets(
      resolved.repoId,
      resolved.repoOwner,
      resolved.repoName,
      body.secrets
    );

    logger.info("repo.secrets_updated", {
      event: "repo.secrets_updated",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof RepoSecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * List secret keys for a repository.
 */
async function handleListRepoSecrets(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets list", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const secrets = await store.listSecretKeys(resolved.repoId);

    logger.info("repo.secrets_listed", {
      event: "repo.secrets_listed",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: secrets.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      secrets,
    });
  } catch (e) {
    logger.error("Failed to list repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * Delete a secret for a repository.
 */
async function handleDeleteRepoSecret(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const key = match.groups?.key;
  if (!owner || !name || !key) {
    return error("Owner, name, and key are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets delete", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    store.validateKey(store.normalizeKey(key));

    const deleted = await store.deleteSecret(resolved.repoId, key);
    if (!deleted) {
      return error("Secret not found", 404);
    }

    logger.info("repo.secret_deleted", {
      event: "repo.secret_deleted",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "deleted",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      key: store.normalizeKey(key),
    });
  } catch (e) {
    if (e instanceof RepoSecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete repo secret", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}
