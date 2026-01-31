/**
 * API router for Open-Inspect Control Plane.
 */

import type { Env, CreateSessionRequest, CreateSessionResponse } from "./types";
import { generateId, encryptToken } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import { getGitHubAppConfig, listInstallationRepositories } from "./auth/github-app";
import { listIssues, createIssue, updateIssue, listTeams } from "./linear/client";
import type {
  EnrichedRepository,
  InstallationRepository,
  RepoMetadata,
} from "@open-inspect/shared";
import { getRepoMetadataKey } from "./utils/repo";

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
const PUBLIC_ROUTES: RegExp[] = [
  /^\/health$/,
  /^\/sessions\/[^/]+\/artifacts\/[^/]+\/file$/, // Artifact files (screenshots) are public
];

/**
 * Routes that accept sandbox authentication.
 * These are session-specific routes that can be called by sandboxes using their auth token.
 * The sandbox token is validated by the Durable Object.
 */
const SANDBOX_AUTH_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/pr$/, // PR creation from sandbox
  /^\/sessions\/[^/]+\/artifacts$/, // Artifact upload (screenshot, preview) from sandbox
  /^\/sessions\/[^/]+\/preview-url$/, // Get preview tunnel URL (sandbox)
  /^\/sessions\/[^/]+\/stream-frame$/, // Screenshot stream frames from sandbox
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
  sessionId: string
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
    console.warn(
      `[auth] Sandbox auth failed for ${request.method} /sessions/${sessionId}/pr from ${clientIP}`
    );
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
  path: string
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    console.error("[auth] INTERNAL_CALLBACK_SECRET not configured - rejecting request");
    return error("Internal authentication not configured", 500);
  }

  const isValid = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!isValid) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    console.warn(`[auth] Authentication failed for ${request.method} ${path} from ${clientIP}`);
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
    method: "POST",
    pattern: parsePattern("/sessions/:id/artifacts"),
    handler: handlePostArtifact,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/artifacts/:artifactId/file"),
    handler: handleGetArtifactFile,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/preview-url"),
    handler: handleGetPreviewUrl,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/stream-frame"),
    handler: handleStreamFrame,
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
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/element-at-point"),
    handler: handleSessionElementAtPoint,
  },

  // Linear integration
  {
    method: "GET",
    pattern: parsePattern("/linear/issues"),
    handler: handleLinearIssues,
  },
  {
    method: "GET",
    pattern: parsePattern("/linear/teams"),
    handler: handleLinearTeams,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/linear/link-task"),
    handler: handleLinearLinkTask,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/linear/link-session"),
    handler: handleLinearLinkSession,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/linear/create-issue"),
    handler: handleLinearCreateIssue,
  },
  {
    method: "PATCH",
    pattern: parsePattern("/linear/issues/:id"),
    handler: handleLinearUpdateIssue,
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
    const hmacAuthError = await requireInternalAuth(request, env, path);

    if (hmacAuthError) {
      // HMAC auth failed - check if this route accepts sandbox auth
      if (isSandboxAuthRoute(path)) {
        // Extract session ID from path (e.g., /sessions/abc123/pr -> abc123)
        // Match /sessions/:id/... or /sessions/:id (e.g. /sessions/abc123/artifacts)
        const sessionIdMatch = path.match(/^\/sessions\/([^/]+)(?:\/|$)/);
        if (sessionIdMatch) {
          const sessionId = sessionIdMatch[1];
          const sandboxAuthError = await verifySandboxAuth(request, env, sessionId);
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
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: corsHeaders,
        });
      } catch (e) {
        console.error("Route handler error:", e);
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
      console.error("Failed to encrypt GitHub token:", e);
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
  console.log("handleSessionPrompt: start");
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  console.log("handleSessionPrompt: sessionId", sessionId);
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

  console.log("handleSessionPrompt: getting DO stub");
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  console.log("handleSessionPrompt: calling DO");
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

  console.log("handleSessionPrompt: response status", response.status);
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

async function handlePostArtifact(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const url = new URL(request.url);
  const internalUrl = `http://internal/internal/artifacts${url.search}`;
  const forwarded = new Request(internalUrl, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  return stub.fetch(forwarded);
}

async function handleGetArtifactFile(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) return error("Session ID and artifact ID required");

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const url = new URL(request.url);
  return stub.fetch(
    new Request(`http://internal/internal/artifacts/${artifactId}/file${url.search}`)
  );
}

async function handleGetPreviewUrl(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  // Forward query params for port-specific URLs
  const url = new URL(request.url);
  const internalUrl = new URL("http://internal/internal/preview-url");
  internalUrl.search = url.search;

  return stub.fetch(new Request(internalUrl.toString()));
}

async function handleStreamFrame(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  // Forward the stream frame to the Durable Object
  return stub.fetch(
    new Request("http://internal/internal/stream-frame", {
      method: "POST",
      headers: request.headers,
      body: request.body,
    })
  );
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
      console.error("[router] Failed to encrypt GitHub token:", e);
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

async function handleSessionElementAtPoint(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let body: { x: number; y: number; viewportWidth?: number; viewportHeight?: number };
  try {
    body = (await request.json()) as {
      x: number;
      y: number;
      viewportWidth?: number;
      viewportHeight?: number;
    };
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (typeof body.x !== "number" || typeof body.y !== "number") {
    return error("x and y (numbers) required", 400);
  }

  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const payload: { x: number; y: number; viewportWidth?: number; viewportHeight?: number } = {
    x: body.x,
    y: body.y,
  };
  if (typeof body.viewportWidth === "number" && typeof body.viewportHeight === "number") {
    payload.viewportWidth = body.viewportWidth;
    payload.viewportHeight = body.viewportHeight;
  }
  const response = await stub.fetch(
    new Request("http://internal/internal/element-at-point", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    return json(err, response.status);
  }

  const data = await response.json();
  return json(data);
}

async function handleLinearIssues(
  request: Request,
  env: Env,
  _match: RegExpMatchArray
): Promise<Response> {
  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }
  const url = new URL(request.url);
  const teamId = url.searchParams.get("teamId") ?? undefined;
  const teamKey = url.searchParams.get("teamKey") ?? undefined;
  const query = url.searchParams.get("query") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = url.searchParams.get("limit");
  try {
    const result = await listIssues(env, {
      teamId,
      teamKey,
      query,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return json({
      issues: result.issues,
      cursor: result.cursor,
      hasMore: result.hasMore,
    });
  } catch (e) {
    console.error("[router] Linear listIssues error:", e);
    const msg = e instanceof Error ? e.message : "Failed to list Linear issues";
    return error(msg, 500);
  }
}

async function handleLinearTeams(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray
): Promise<Response> {
  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }
  try {
    const teams = await listTeams(env);
    return json({ teams });
  } catch (e) {
    console.error("[router] Linear listTeams error:", e);
    const msg = e instanceof Error ? e.message : "Failed to list Linear teams";
    return error(msg, 500);
  }
}

async function handleLinearLinkTask(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let body: { messageId: string; eventId: string; taskIndex: number; linearIssueId: string };
  try {
    body = (await request.json()) as {
      messageId: string;
      eventId: string;
      taskIndex: number;
      linearIssueId: string;
    };
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (
    !body.messageId ||
    !body.eventId ||
    typeof body.taskIndex !== "number" ||
    !body.linearIssueId
  ) {
    return error("messageId, eventId, taskIndex, and linearIssueId are required", 400);
  }

  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const response = await stub.fetch(
    new Request("http://internal/internal/linear/link-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return response;
}

async function handleLinearLinkSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let body: { linearIssueId?: string | null; linearTeamId?: string | null };
  try {
    body = (await request.json()) as {
      linearIssueId?: string | null;
      linearTeamId?: string | null;
    };
  } catch {
    return error("Invalid JSON body", 400);
  }
  const payload: { linearIssueId?: string | null; linearTeamId?: string | null } = {};
  if ("linearIssueId" in body) payload.linearIssueId = body.linearIssueId ?? null;
  if ("linearTeamId" in body) payload.linearTeamId = body.linearTeamId ?? null;

  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const response = await stub.fetch(
    new Request("http://internal/internal/linear/link-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  return response;
}

async function handleLinearCreateIssue(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }

  let body: {
    messageId: string;
    eventId: string;
    taskIndex: number;
    teamId: string;
    title?: string;
    description?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body.messageId || !body.eventId || typeof body.taskIndex !== "number" || !body.teamId) {
    return error("messageId, eventId, taskIndex, and teamId are required", 400);
  }

  const title = body.title?.trim() || "Task from Open-Inspect";
  const description = body.description ?? undefined;

  try {
    const issue = await createIssue(env, {
      teamId: body.teamId,
      title,
      description: description ?? null,
    });
    const stub = getSessionStub(env, match);
    if (!stub) return error("Session ID required");
    const linkResponse = await stub.fetch(
      new Request("http://internal/internal/linear/link-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: body.messageId,
          eventId: body.eventId,
          taskIndex: body.taskIndex,
          linearIssueId: issue.id,
        }),
      })
    );
    if (!linkResponse.ok) {
      console.error("[router] Linear link-task after create failed:", await linkResponse.text());
      return json({ issue, linked: false }, 201);
    }
    return json({ issue, linked: true }, 201);
  } catch (e) {
    console.error("[router] Linear createIssue error:", e);
    const msg = e instanceof Error ? e.message : "Failed to create Linear issue";
    return error(msg, 500);
  }
}

async function handleLinearUpdateIssue(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const issueId = match.groups?.id;
  if (!issueId) return error("Issue ID required");

  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }

  let body: { stateId?: string; assigneeId?: string | null; title?: string; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  try {
    const issue = await updateIssue(env, issueId, {
      stateId: body.stateId ?? undefined,
      assigneeId: body.assigneeId ?? undefined,
      title: body.title ?? undefined,
      description: body.description ?? undefined,
    });
    return json(issue);
  } catch (e) {
    console.error("[router] Linear updateIssue error:", e);
    const msg = e instanceof Error ? e.message : "Failed to update Linear issue";
    return error(msg, 500);
  }
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
      console.warn(`Session ${sessionId} not found in KV index during archive`);
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
      console.warn(`Session ${sessionId} not found in KV index during unarchive`);
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
    console.warn("Failed to read repos cache:", e);
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
    console.error("Failed to list installation repositories:", e);
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
            console.log(`Migrated metadata from ${oldKey} to ${newKey}`);
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
    console.warn("Failed to cache repos list:", e);
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
    console.error("Failed to update repo metadata:", e);
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
    console.error("Failed to get repo metadata:", e);
    return error("Failed to get metadata", 500);
  }
}
