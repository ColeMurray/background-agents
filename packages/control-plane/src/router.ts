/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env, CreateSessionRequest, CreateSessionResponse } from "./types";
import { generateId, encryptToken } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import { getGitHubAppConfig, listInstallationRepositories } from "./auth/github-app";
import type {
  EnrichedRepository,
  InstallationRepository,
  RepoMetadata,
} from "@open-inspect/shared";
import { getRepoMetadataKey } from "./utils/repo";
import { createLogger, parseLogLevel } from "./logger";
import type { Logger } from "./logger";

// Module-level logger for route handlers. Uses default "info" level since env
// is not available at module scope. This is fine — route handlers don't emit
// debug-level logs, and Cloudflare Workers Logs indexes the JSON "level" field
// for filtering at query time regardless.
const routerLog = createLogger("router");

/**
 * Route configuration.
 */
interface Route {
  method: string;
  pattern: RegExp;
  handler: (request: Request, env: Env, match: RegExpMatchArray) => Promise<Response>;
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
 * @returns null if authentication passes, or an error Response to return immediately
 */
async function verifySandboxAuth(
  request: Request,
  env: Env,
  sessionId: string,
  log: Logger
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
    new Request("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
  );

  if (!verifyResponse.ok) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    log.warn("Auth failed: sandbox", {
      path: new URL(request.url).pathname,
      ip: clientIP,
      sessionId,
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
 * @returns null if authentication passes, or an error Response to return immediately
 */
async function requireInternalAuth(
  request: Request,
  env: Env,
  path: string,
  log: Logger
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    log.error("INTERNAL_CALLBACK_SECRET not configured - rejecting request");
    return error("Internal authentication not configured", 500);
  }

  const isValid = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!isValid) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    log.warn("Auth failed: HMAC", { path, ip: clientIP });
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
];

/**
 * Match request to route and execute handler.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const requestId = crypto.randomUUID().slice(0, 8);
  const log = createLogger("router", { requestId }, parseLogLevel(env.LOG_LEVEL));
  const startTime = Date.now();

  log.info("API request", { method, path });

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Require authentication for non-public routes
  if (!isPublicRoute(path)) {
    // First try HMAC auth (for web app, slack bot, etc.)
    const hmacAuthError = await requireInternalAuth(request, env, path, log);

    if (hmacAuthError) {
      // HMAC auth failed - check if this route accepts sandbox auth
      if (isSandboxAuthRoute(path)) {
        // Extract session ID from path (e.g., /sessions/abc123/pr -> abc123)
        const sessionIdMatch = path.match(/^\/sessions\/([^/]+)\//);
        if (sessionIdMatch) {
          const sessionId = sessionIdMatch[1];
          const sandboxAuthError = await verifySandboxAuth(request, env, sessionId, log);
          if (!sandboxAuthError) {
            // Sandbox auth passed, continue to route handler
          } else {
            // Both HMAC and sandbox auth failed
            const corsHeaders = new Headers(sandboxAuthError.headers);
            corsHeaders.set("Access-Control-Allow-Origin", "*");
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
      try {
        const response = await route.handler(request, env, match);
        // Create new response with CORS headers (original response may be immutable)
        const corsHeaders = new Headers(response.headers);
        corsHeaders.set("Access-Control-Allow-Origin", "*");
        log.info("API response", {
          method,
          path,
          status: response.status,
          durationMs: Date.now() - startTime,
        });
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: corsHeaders,
        });
      } catch (e) {
        log.error("Request error", {
          error: e instanceof Error ? e : String(e),
          status: 500,
          path,
        });
        return error("Internal server error", 500);
      }
    }
  }

  return error("Not found", 404);
}

// Session handlers

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray
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
  _match: RegExpMatchArray
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
      routerLog.error("Failed to encrypt GitHub token", {
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
    new Request("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: sessionId, // Pass the session name for WebSocket routing
        repoOwner,
        repoName,
        title: body.title,
        model: body.model || "claude-haiku-4-5", // Default to haiku for cost efficiency
        userId,
        githubLogin,
        githubName,
        githubEmail,
        githubTokenEncrypted, // Pass encrypted token to store with owner
      }),
    })
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
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(new Request("http://internal/internal/state"));

  if (!response.ok) {
    return error("Session not found", 404);
  }

  return response;
}

async function handleDeleteSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray
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
  match: RegExpMatchArray
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
    new Request("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: body.content,
        authorId: body.authorId || "anonymous",
        source: body.source || "web",
        attachments: body.attachments,
        callbackContext: body.callbackContext,
      }),
    })
  );

  routerLog.info("Prompt enqueued via API", { sessionId, status: response.status });
  return response;
}

async function handleSessionStop(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(new Request("http://internal/internal/stop", { method: "POST" }));
}

async function handleSessionEvents(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const url = new URL(request.url);
  return stub.fetch(new Request(`http://internal/internal/events${url.search}`));
}

async function handleSessionArtifacts(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(new Request("http://internal/internal/artifacts"));
}

async function handleSessionParticipants(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(new Request("http://internal/internal/participants"));
}

async function handleAddParticipant(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = await request.json();

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    new Request("http://internal/internal/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

  return response;
}

async function handleSessionMessages(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const url = new URL(request.url);
  return stub.fetch(new Request(`http://internal/internal/messages${url.search}`));
}

async function handleCreatePR(
  request: Request,
  env: Env,
  match: RegExpMatchArray
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
    new Request("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: body.title,
        body: body.body,
        baseBranch: body.baseBranch,
      }),
    })
  );

  return response;
}

async function handleSessionWsToken(
  request: Request,
  env: Env,
  match: RegExpMatchArray
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
      routerLog.error("Failed to encrypt GitHub token", {
        error: e instanceof Error ? e : String(e),
      });
      // Continue without token - PR creation will fail if this user triggers it
    }
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    new Request("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: body.userId,
        githubUserId: body.githubUserId,
        githubLogin: body.githubLogin,
        githubName: body.githubName,
        githubEmail: body.githubEmail,
        githubTokenEncrypted,
        githubTokenExpiresAt: body.githubTokenExpiresAt,
      }),
    })
  );

  return response;
}

async function handleArchiveSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray
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
    new Request("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })
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
      routerLog.warn("Session not found in KV index during archive", { sessionId });
    }
  }

  return response;
}

async function handleUnarchiveSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray
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
    new Request("http://internal/internal/unarchive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })
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
      routerLog.warn("Session not found in KV index during unarchive", { sessionId });
    }
  }

  return response;
}

// Repository handlers

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
  _match: RegExpMatchArray
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
    routerLog.warn("Failed to read repos cache", { error: e instanceof Error ? e : String(e) });
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
    routerLog.error("Failed to list installation repositories", {
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
            routerLog.info("Migrated repo metadata key", { oldKey, newKey });
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
    routerLog.warn("Failed to cache repos list", { error: e instanceof Error ? e : String(e) });
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
  match: RegExpMatchArray
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
    routerLog.error("Failed to update repo metadata", {
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
  match: RegExpMatchArray
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
    routerLog.error("Failed to get repo metadata", { error: e instanceof Error ? e : String(e) });
    return error("Failed to get metadata", 500);
  }
}
