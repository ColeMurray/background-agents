/**
 * API router for Open-Inspect Control Plane.
 */

import type {
  ArtifactResponse,
  Env,
  CreateSessionRequest,
  CreateSessionResponse,
  SpawnSource,
} from "./types";
import { generateId, encryptTokenPair } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import {
  buildMediaObjectKey,
  detectScreenshotFileType,
  isMultipartFile,
  isSupportedScreenshotMimeType,
  type MultipartFieldValue,
  parseOptionalBoolean,
  parseOptionalViewport,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_UPLOAD_LIMIT_PER_SESSION,
} from "./media";
import {
  resolveScmProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProviderName,
} from "./source-control";
import { IntegrationSettingsStore } from "./db/integration-settings";
import { SessionIndexStore } from "./db/session-index";
import { UserScmTokenStore, DEFAULT_TOKEN_LIFETIME_MS } from "./db/user-scm-tokens";
import { UserStore, type ProviderIdentity } from "./db/user-store";
import { buildSessionInternalUrl, SessionInternalPaths } from "./session/contracts";

import {
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  VALID_MODELS,
  type CodeServerSettings,
  type SandboxSettings,
  type ScreenshotArtifactMetadata,
  type SessionStatus,
  type CallbackContext,
  type SpawnChildSessionRequest,
  type SpawnContext,
} from "@open-inspect/shared";
import { createRequestMetrics, instrumentD1 } from "./db/instrumented-d1";
import { createLogger } from "./logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  resolveRepoOrError,
} from "./routes/shared";
import { integrationSettingsRoutes } from "./routes/integration-settings";
import { modelPreferencesRoutes } from "./routes/model-preferences";
import { reposRoutes } from "./routes/repos";
import { repoImageRoutes } from "./routes/repo-images";
import { secretsRoutes } from "./routes/secrets";
import { automationRoutes } from "./routes/automations";
import { mcpServerRoutes } from "./routes/mcp-servers";
import { analyticsRoutes } from "./routes/analytics";
import { webhookRoutes } from "./webhooks";

const logger = createLogger("router");

// Guardrail constants for agent-spawned child sessions
const MAX_SPAWN_DEPTH = 2;
const MAX_CONCURRENT_CHILDREN = 5;
const MAX_TOTAL_CHILDREN = 15;

/**
 * Resolve whether code-server should be enabled for a given repo,
 * checking both the `enabled` setting and the `enabledRepos` allowlist.
 */
async function resolveCodeServerEnabled(
  db: D1Database | undefined,
  repoOwner: string,
  repoName: string
): Promise<boolean> {
  if (!db) return false;
  const repo = `${repoOwner}/${repoName}`;
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig("code-server", repo);
    const csSettings = settings as CodeServerSettings;
    if (csSettings.enabled !== true) return false;
    // enabledRepos: null → all repos, [] → none, [...] → allowlist
    if (enabledRepos !== null && !enabledRepos.includes(repo)) return false;
    return true;
  } catch (e) {
    logger.warn("Failed to resolve code-server integration settings, defaulting to disabled", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Resolve sandbox settings for a given repo, merging global defaults with per-repo overrides.
 */
async function resolveSandboxSettings(
  db: D1Database | undefined,
  repoOwner: string,
  repoName: string
): Promise<SandboxSettings> {
  if (!db) return {};
  const repo = `${repoOwner}/${repoName}`;
  try {
    const store = new IntegrationSettingsStore(db);
    const { enabledRepos, settings } = await store.getResolvedConfig("sandbox", repo);
    // enabledRepos: null → all repos, [] → none, [...] → allowlist
    if (enabledRepos !== null && !enabledRepos.includes(repo)) return {};
    return settings as SandboxSettings;
  } catch (e) {
    logger.warn("Failed to resolve sandbox settings, using defaults", {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];

function parseSessionStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  return SESSION_STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : undefined;
}

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
const PUBLIC_ROUTES: RegExp[] = [
  /^\/health$/,
  /^\/webhooks\/sentry\/[^/]+$/,
  /^\/webhooks\/automation\/[^/]+$/,
];

/**
 * Routes that accept sandbox authentication.
 * These are session-specific routes that can be called by sandboxes using their auth token.
 * The sandbox token is validated by the Durable Object.
 */
const SANDBOX_AUTH_ROUTES: RegExp[] = [
  /^\/sessions\/[^/]+\/pr$/, // PR creation from sandbox
  /^\/sessions\/[^/]+\/openai-token-refresh$/, // OpenAI token refresh from sandbox
  /^\/sessions\/[^/]+\/media$/, // Media upload from sandbox
  /^\/sessions\/[^/]+\/children$/, // POST spawn, GET list
  /^\/sessions\/[^/]+\/children\/[^/]+$/, // GET child detail
  /^\/sessions\/[^/]+\/children\/[^/]+\/cancel$/, // POST cancel child
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
  return /^\/analytics\/(summary|timeseries|breakdown)$/.test(path);
}

function enforceImplementedScmProvider(
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveDeploymentScmProvider(env);
    if (provider !== "github" && !isPublicRoute(path) && !isScmAgnosticRoute(path)) {
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
      buildSessionInternalUrl(SessionInternalPaths.verifySandboxToken),
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
    pattern: parsePattern("/sessions/:id/media"),
    handler: handleMediaUpload,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/media/:artifactId"),
    handler: handleMediaGet,
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
    method: "PATCH",
    pattern: parsePattern("/sessions/:id/title"),
    handler: handleUpdateSessionTitle,
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

  // Child session management (sandbox-authenticated)
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleSpawnChild,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleListChildren,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/children/:childId"),
    handler: handleGetChild,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/children/:childId/cancel"),
    handler: handleCancelChild,
  },

  // Repository management
  ...reposRoutes,

  // Secrets
  ...secretsRoutes,

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
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  const store = new SessionIndexStore(env.DB);
  const result = await store.list({ status, excludeStatus, limit, offset });

  return json({
    sessions: result.sessions,
    total: result.total,
    hasMore: result.hasMore,
  });
}

/**
 * Derives a ProviderIdentity from spawnSource and the request body.
 * For GitHub-based callers (web + github-bot), reuses existing scm* fields.
 * For Slack/Linear bots, uses the actor* fields.
 *
 * Returns null when the caller hasn't supplied the required provider-specific
 * ID (scmUserId for GitHub, actorUserId for Slack/Linear). This is expected
 * during the phased rollout: Phase 2 wires this plumbing, Phase 4 updates
 * each bot to send identity fields. Until then, bot sessions get user_id = NULL.
 */
function resolveProviderIdentity(
  spawnSource: SpawnSource,
  body: {
    scmUserId?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    scmAvatarUrl?: string;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    actorAvatarUrl?: string;
  }
): ProviderIdentity | null {
  switch (spawnSource) {
    case "user":
    case "github-bot":
      return body.scmUserId
        ? {
            provider: "github",
            providerUserId: body.scmUserId,
            providerLogin: body.scmLogin,
            providerEmail: body.scmEmail,
            displayName: body.scmName || body.scmLogin,
            avatarUrl: body.scmAvatarUrl,
          }
        : null;

    case "slack-bot":
      return body.actorUserId
        ? {
            provider: "slack",
            providerUserId: body.actorUserId,
            providerEmail: body.actorEmail,
            displayName: body.actorDisplayName,
            avatarUrl: body.actorAvatarUrl,
          }
        : null;

    case "linear-bot":
      return body.actorUserId
        ? {
            provider: "linear",
            providerUserId: body.actorUserId,
            providerEmail: body.actorEmail,
            displayName: body.actorDisplayName,
          }
        : null;

    default:
      return null;
  }
}

/**
 * Parse a bot-format authorId into provider + providerUserId.
 * Returns null for web client authorIds (plain user IDs without a prefix).
 */
export function parseAuthorId(
  authorId: string
): { provider: string; providerUserId: string } | null {
  const match = authorId.match(/^(github|slack|linear):(.+)$/);
  if (!match) return null;
  return { provider: match[1], providerUserId: match[2] };
}

/**
 * Construct a canonical userId from the bot's identity fields, matching the
 * format each bot uses for prompt `authorId`. This ensures the owner
 * participant created at init is findable when the bot later sends a prompt.
 */
export function deriveUserId(body: {
  userId?: string;
  spawnSource?: SpawnSource;
  scmUserId?: string;
  actorUserId?: string;
}): string {
  switch (body.spawnSource) {
    case "github-bot":
      return body.scmUserId ? `github:${body.scmUserId}` : "anonymous";
    case "slack-bot":
      return body.actorUserId ? `slack:${body.actorUserId}` : "anonymous";
    case "linear-bot":
      return body.actorUserId ? `linear:${body.actorUserId}` : "anonymous";
    default:
      return body.userId || "anonymous";
  }
}

interface GitHubEnrichment {
  scmUserId: string;
  scmLogin?: string;
  displayName?: string;
  email?: string;
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt?: number;
}

/**
 * Given a resolved D1 user, find their linked GitHub identity and return
 * enrichment data (display name, email, OAuth tokens). Returns null if no
 * GitHub identity is linked. Parallelizes independent D1 lookups.
 */
async function resolveGitHubEnrichment(
  env: Env,
  userStore: UserStore,
  userId: string
): Promise<GitHubEnrichment | null> {
  const identities = await userStore.getIdentitiesForUser(userId);
  const githubIdentity = identities.find((i) => i.provider === "github");
  if (!githubIdentity) return null;

  const [user, tokens] = await Promise.all([
    userStore.getUserById(userId),
    env.TOKEN_ENCRYPTION_KEY
      ? new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY).getEncryptedTokens(
          githubIdentity.providerUserId
        )
      : null,
  ]);

  const email =
    githubIdentity.providerEmail ??
    (githubIdentity.providerLogin
      ? `${githubIdentity.providerUserId}+${githubIdentity.providerLogin}@users.noreply.github.com`
      : undefined);

  return {
    scmUserId: githubIdentity.providerUserId,
    scmLogin: githubIdentity.providerLogin ?? undefined,
    displayName: user?.displayName ?? githubIdentity.providerLogin ?? undefined,
    email,
    accessTokenEncrypted: tokens?.accessTokenEncrypted,
    refreshTokenEncrypted: tokens?.refreshTokenEncrypted,
    tokenExpiresAt: tokens?.expiresAt,
  };
}

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as CreateSessionRequest & {
    scmToken?: string;
    scmRefreshToken?: string;
    scmTokenExpiresAt?: number;
    scmUserId?: string;
    userId?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    spawnSource?: SpawnSource;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    actorAvatarUrl?: string;
  };

  if (!body.repoOwner || !body.repoName) {
    return error("repoOwner and repoName are required");
  }

  // Validate branch name if provided (defense in depth)
  if (body.branch && !/^[\w.\-/]+$/.test(body.branch)) {
    return error("Invalid branch name");
  }

  // Normalize repo identifiers to lowercase for consistent storage
  const repoOwner = body.repoOwner.toLowerCase();
  const repoName = body.repoName.toLowerCase();

  const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);
  if (resolved instanceof Response) return resolved;

  const { repoId, defaultBranch } = resolved;

  const userId = deriveUserId(body);

  // Resolve canonical user model ID (for D1 session index).
  // Best-effort: if resolution fails, the session is created without a user_id.
  const userStore = new UserStore(env.DB);
  let resolvedUserId: string | null = null;
  const providerIdentity = resolveProviderIdentity(body.spawnSource ?? "user", body);
  if (providerIdentity) {
    try {
      const resolvedUser = await userStore.resolveOrCreateUser(providerIdentity);
      resolvedUserId = resolvedUser.id;
    } catch (e) {
      logger.warn("Failed to resolve user identity, session will have no user_id", {
        error: e instanceof Error ? e : String(e),
        provider: providerIdentity.provider,
      });
    }
  }

  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  const scmToken = body.scmToken;
  const scmRefreshToken = body.scmRefreshToken;
  let scmTokenExpiresAt = body.scmTokenExpiresAt;
  let scmUserId = body.scmUserId;
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      ({
        accessTokenEncrypted: scmTokenEncrypted,
        refreshTokenEncrypted: scmRefreshTokenEncrypted,
      } = await encryptTokenPair(scmToken, scmRefreshToken, env.TOKEN_ENCRYPTION_KEY));
    } catch (e) {
      logger.error("Failed to encrypt SCM token", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("Failed to process SCM token", 500);
    }
  }

  // Enrich owner participant with linked GitHub identity from D1.
  // Fills in SCM fields the bot didn't provide (email, display name, OAuth tokens).
  if (resolvedUserId) {
    try {
      const enrichment = await resolveGitHubEnrichment(env, userStore, resolvedUserId);
      if (enrichment) {
        scmUserId ??= enrichment.scmUserId;
        scmLogin ??= enrichment.scmLogin;
        scmName ??= enrichment.displayName;
        scmEmail ??= enrichment.email;
        if (!scmTokenEncrypted) {
          scmTokenEncrypted = enrichment.accessTokenEncrypted ?? null;
          scmRefreshTokenEncrypted = enrichment.refreshTokenEncrypted ?? null;
          scmTokenExpiresAt = enrichment.tokenExpiresAt;
        }
      }
    } catch (e) {
      logger.warn("Failed to enrich session with GitHub identity", {
        error: e instanceof Error ? e : String(e),
      });
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

  // Resolve code-server integration setting and sandbox settings for this repo
  const [codeServerEnabled, sandboxSettings] = await Promise.all([
    resolveCodeServerEnabled(env.DB, repoOwner, repoName),
    resolveSandboxSettings(env.DB, repoOwner, repoName),
  ]);

  // Store session in D1 before initializing the SessionDO. SessionDO init starts
  // sandbox warming, so D1 failures must fail before any sandbox can be spawned.
  const now = Date.now();
  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.create({
    id: sessionId,
    title: body.title || null,
    repoOwner,
    repoName,
    model,
    reasoningEffort,
    baseBranch: body.branch || defaultBranch || "main",
    status: "created",
    spawnSource: body.spawnSource,
    scmLogin: scmLogin || null,
    userId: resolvedUserId,
    createdAt: now,
    updatedAt: now,
  });

  // Initialize session with user info and optional encrypted token
  const initResponse = await stub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.init),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName: sessionId, // Pass the session name for WebSocket routing
          repoOwner,
          repoName,
          repoId,
          defaultBranch,
          branch: body.branch,
          title: body.title,
          model,
          reasoningEffort,
          userId,
          scmLogin,
          scmName,
          scmEmail,
          scmTokenEncrypted,
          scmRefreshTokenEncrypted,
          scmTokenExpiresAt,
          scmUserId,
          codeServerEnabled,
          sandboxSettings,
          spawnSource: body.spawnSource,
        }),
      },
      ctx
    )
  );

  if (!initResponse.ok) {
    return error("Failed to create session", 500);
  }

  // Populate D1 with the user's SCM tokens (non-blocking) so centralized refresh works
  if (scmUserId && scmToken && scmRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    ctx.executionCtx?.waitUntil(
      new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
        .upsertTokens(
          scmUserId,
          scmToken,
          scmRefreshToken,
          scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
          resolvedUserId
        )
        .catch((e) =>
          logger.error("Failed to write tokens to D1", {
            error: e instanceof Error ? e : String(e),
          })
        )
    );
  }

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
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.state), undefined, ctx)
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

  const authorId = body.authorId || "anonymous";

  // Enrich bot-originated prompts with linked GitHub identity from D1.
  // Web client authorIds have no provider prefix — parseAuthorId returns null, skipping this.
  let enrichment: GitHubEnrichment | undefined;
  const parsed = parseAuthorId(authorId);
  if (parsed) {
    try {
      const userStore = new UserStore(env.DB);
      const identity = await userStore.getIdentity(parsed.provider, parsed.providerUserId);
      if (identity) {
        enrichment = (await resolveGitHubEnrichment(env, userStore, identity.userId)) ?? undefined;
      }
    } catch (e) {
      logger.warn("Failed to enrich prompt with GitHub identity", {
        error: e instanceof Error ? e : String(e),
        authorId,
      });
    }
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.prompt),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: body.content,
          authorId,
          source: body.source || "web",
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          attachments: body.attachments,
          callbackContext: body.callbackContext,
          authorDisplayName: enrichment?.displayName,
          authorEmail: enrichment?.email,
          authorLogin: enrichment?.scmLogin,
          scmUserId: enrichment?.scmUserId,
          scmAccessTokenEncrypted: enrichment?.accessTokenEncrypted,
          scmRefreshTokenEncrypted: enrichment?.refreshTokenEncrypted,
          scmTokenExpiresAt: enrichment?.tokenExpiresAt,
        }),
      },
      ctx
    )
  );

  // Background: update D1 timestamp so session bubbles to top of sidebar
  const store = new SessionIndexStore(env.DB);
  ctx.executionCtx?.waitUntil(
    store.touchUpdatedAt(sessionId).catch((error) => {
      logger.error("session_index.touch_updated_at.background_error", {
        session_id: sessionId,
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
        error,
      });
    })
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

  return stub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.stop), { method: "POST" }, ctx)
  );
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
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.events, url.search),
      undefined,
      ctx
    )
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

  return stub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.artifacts), undefined, ctx)
  );
}

function getRequiredFormString(value: MultipartFieldValue | null, name: string): string | Response {
  if (typeof value !== "string" || value.trim().length === 0) {
    return error(`${name} is required`, 400);
  }

  return value.trim();
}

function getOptionalFormString(value: MultipartFieldValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function listSessionArtifactsFromDo(
  stub: DurableObjectStub,
  ctx: RequestContext
): Promise<ArtifactResponse[] | Response> {
  const response = await stub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.artifacts), undefined, ctx)
  );
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to list session artifacts", 500);
  }

  const data = (await response.json()) as { artifacts: ArtifactResponse[] };
  return data.artifacts;
}

async function getSessionArtifactFromDo(
  stub: DurableObjectStub,
  artifactId: string,
  ctx: RequestContext
): Promise<ArtifactResponse | null | Response> {
  const response = await stub.fetch(
    internalRequest(
      buildSessionInternalUrl(
        SessionInternalPaths.artifacts,
        `?artifactId=${encodeURIComponent(artifactId)}`
      ),
      undefined,
      ctx
    )
  );
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to fetch session artifact", 500);
  }

  const data = (await response.json()) as { artifact: ArtifactResponse | null };
  return data.artifact;
}

function getScreenshotMimeType(
  artifact: Pick<ArtifactResponse, "metadata">
): "image/png" | "image/jpeg" | "image/webp" | null {
  const mimeType = artifact.metadata?.mimeType;
  return typeof mimeType === "string" && isSupportedScreenshotMimeType(mimeType) ? mimeType : null;
}

function getContentTypeFromHeaders(
  headers: Headers
): "image/png" | "image/jpeg" | "image/webp" | null {
  const contentType = headers.get("Content-Type");
  return contentType && isSupportedScreenshotMimeType(contentType) ? contentType : null;
}

async function handleMediaUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return error("Invalid multipart form data", 400);
  }

  const fileEntry = formData.get("file");
  if (!isMultipartFile(fileEntry)) {
    return error("file is required", 400);
  }

  const artifactTypeField = getRequiredFormString(formData.get("artifactType"), "artifactType");
  if (artifactTypeField instanceof Response) return artifactTypeField;
  if (artifactTypeField !== "screenshot") {
    return error("Only screenshot uploads are supported", 400);
  }

  if (fileEntry.size <= 0) {
    return error("Uploaded file is empty", 400);
  }

  if (fileEntry.size > SCREENSHOT_MAX_BYTES) {
    return error(`Screenshot uploads must be ${SCREENSHOT_MAX_BYTES} bytes or smaller`, 400);
  }

  if (
    fileEntry.type &&
    fileEntry.type !== "image/png" &&
    fileEntry.type !== "image/jpeg" &&
    fileEntry.type !== "image/webp"
  ) {
    return error("Unsupported screenshot MIME type", 400);
  }

  let fullPage: boolean | undefined;
  let annotated: boolean | undefined;
  let viewport: { width: number; height: number } | undefined;
  try {
    fullPage = parseOptionalBoolean(formData.get("fullPage"));
    annotated = parseOptionalBoolean(formData.get("annotated"));
    viewport = parseOptionalViewport(formData.get("viewport"));
  } catch (fieldError) {
    return error(
      fieldError instanceof Error ? fieldError.message : "Invalid screenshot metadata",
      400
    );
  }

  const caption = getOptionalFormString(formData.get("caption"));
  const sourceUrl = getOptionalFormString(formData.get("sourceUrl"));
  if (sourceUrl) {
    try {
      new URL(sourceUrl);
    } catch {
      return error("sourceUrl must be a valid URL", 400);
    }
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detectedFileType = detectScreenshotFileType(bytes);
  if (!detectedFileType) {
    return error("Uploaded file is not a supported screenshot format", 400);
  }

  if (fileEntry.type && fileEntry.type !== detectedFileType.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);
  const artifactsResult = await listSessionArtifactsFromDo(stub, ctx);
  if (artifactsResult instanceof Response) return artifactsResult;

  const screenshotCount = artifactsResult.filter(
    (artifact) => artifact.type === "screenshot"
  ).length;
  if (screenshotCount >= SCREENSHOT_UPLOAD_LIMIT_PER_SESSION) {
    return error(
      `Session screenshot limit of ${SCREENSHOT_UPLOAD_LIMIT_PER_SESSION} uploads exceeded`,
      429
    );
  }

  const artifactId = generateId();
  const objectKey = buildMediaObjectKey(sessionId, artifactId, detectedFileType.extension);
  const metadata: ScreenshotArtifactMetadata = {
    objectKey,
    mimeType: detectedFileType.mimeType,
    sizeBytes: bytes.byteLength,
    ...(viewport ? { viewport } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(fullPage !== undefined ? { fullPage } : {}),
    ...(annotated !== undefined ? { annotated } : {}),
    ...(caption ? { caption } : {}),
  };

  await env.MEDIA_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: detectedFileType.mimeType },
  });

  const createArtifactResponse = await stub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.createMediaArtifact),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          artifactType: "screenshot",
          objectKey,
          metadata,
        }),
      },
      ctx
    )
  );

  if (!createArtifactResponse.ok) {
    try {
      await env.MEDIA_BUCKET.delete(objectKey);
    } catch (cleanupError) {
      logger.error("media.upload.cleanup_failed", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: objectKey,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: cleanupError instanceof Error ? cleanupError : String(cleanupError),
      });
    }

    const doErrorText = await createArtifactResponse.text();
    let doErrorMessage = "Failed to persist media artifact";
    if (doErrorText) {
      try {
        const parsedError = JSON.parse(doErrorText) as { error?: unknown };
        if (typeof parsedError.error === "string" && parsedError.error.trim()) {
          doErrorMessage = parsedError.error;
        } else {
          doErrorMessage = doErrorText;
        }
      } catch {
        doErrorMessage = doErrorText;
      }
    }

    const logData = {
      session_id: sessionId,
      artifact_id: artifactId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: doErrorMessage,
      http_status: createArtifactResponse.status,
    };

    if (createArtifactResponse.status >= 500) {
      logger.error("media.upload.create_artifact_failed", logData);
      return error("Failed to persist media artifact", 500);
    }

    logger.warn("media.upload.create_artifact_failed", logData);
    return error(doErrorMessage, createArtifactResponse.status);
  }

  return json({ artifactId, objectKey }, 201);
}

async function handleMediaGet(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  if (!/^[A-Za-z0-9-]+$/.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);
  const artifact = await getSessionArtifactFromDo(stub, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || artifact.type !== "screenshot" || !artifact.url) {
    return error("Media artifact not found", 404);
  }

  const object = await env.MEDIA_BUCKET.get(artifact.url);
  if (!object) {
    logger.warn("media.stream.object_missing", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = getContentTypeFromHeaders(headers) ?? getScreenshotMimeType(artifact);
  if (!contentType) {
    logger.error("media.stream.invalid_metadata", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact is invalid", 500);
  }

  headers.set("Content-Type", contentType);
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));

  return new Response(object.body, { headers });
}

async function handleSessionParticipants(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  return stub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.participants), undefined, ctx)
  );
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
      buildSessionInternalUrl(SessionInternalPaths.participants),
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
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.messages, url.search),
      undefined,
      ctx
    )
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
      buildSessionInternalUrl(SessionInternalPaths.createPr),
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
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.openaiTokenRefresh),
      { method: "POST" },
      ctx
    )
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
    scmUserId?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    scmToken?: string;
    scmTokenExpiresAt?: number;
    scmRefreshToken?: string;
  };

  if (!body.userId) {
    return error("userId is required");
  }

  const scmUserId = body.scmUserId;
  const scmLogin = body.scmLogin;
  const scmName = body.scmName;
  const scmEmail = body.scmEmail;
  const scmToken = body.scmToken;
  const scmTokenExpiresAt = body.scmTokenExpiresAt;
  const scmRefreshToken = body.scmRefreshToken;

  // Encrypt the SCM tokens if provided
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      ({
        accessTokenEncrypted: scmTokenEncrypted,
        refreshTokenEncrypted: scmRefreshTokenEncrypted,
      } = await ctx.metrics.time("encrypt_tokens", () =>
        encryptTokenPair(scmToken, scmRefreshToken, env.TOKEN_ENCRYPTION_KEY!)
      ));
    } catch (e) {
      logger.error("Failed to encrypt SCM tokens", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("Failed to process SCM tokens", 500);
    }
  }

  // Populate D1 with the user's SCM tokens (non-blocking) so centralized refresh works
  if (scmUserId && scmToken && scmRefreshToken && env.TOKEN_ENCRYPTION_KEY) {
    ctx.executionCtx?.waitUntil(
      new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
        .upsertTokens(
          scmUserId,
          scmToken,
          scmRefreshToken,
          scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS
        )
        .catch((e) =>
          logger.error("Failed to write tokens to D1", {
            error: e instanceof Error ? e : String(e),
          })
        )
    );
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await ctx.metrics.time("do_fetch", () =>
    stub.fetch(
      internalRequest(
        buildSessionInternalUrl(SessionInternalPaths.wsToken),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: body.userId,
            scmUserId,
            scmLogin,
            scmName,
            scmEmail,
            scmTokenEncrypted,
            scmRefreshTokenEncrypted,
            scmTokenExpiresAt,
          }),
        },
        ctx
      )
    )
  );

  return response;
}

async function handleUpdateSessionTitle(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let userId: string | undefined;
  let title: string | undefined;

  try {
    const body = (await request.json()) as { userId?: string; title?: string };
    userId = body.userId;
    title = body.title;
  } catch (_error) {
    // Body parsing failed, continue without userId/title
    userId = undefined;
    title = undefined;
  }

  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const response = await stub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.updateTitle),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, title }),
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
      buildSessionInternalUrl(SessionInternalPaths.archive),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
      ctx
    )
  );

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
      buildSessionInternalUrl(SessionInternalPaths.unarchive),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
      ctx
    )
  );

  return response;
}

// Child session handlers

async function handleSpawnChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const body = (await request.json()) as SpawnChildSessionRequest;

  if (!body.title || !body.prompt) {
    return error("title and prompt are required");
  }

  const sessionStore = new SessionIndexStore(env.DB);

  // Guardrail: depth
  const parentDepth = await sessionStore.getSpawnDepth(parentId);
  if (parentDepth >= MAX_SPAWN_DEPTH) {
    return error(`Maximum spawn depth (${MAX_SPAWN_DEPTH}) exceeded`, 403);
  }

  // Guardrail: concurrent children
  const activeCount = await sessionStore.countActiveChildren(parentId);
  if (activeCount >= MAX_CONCURRENT_CHILDREN) {
    return error(`Maximum concurrent children (${MAX_CONCURRENT_CHILDREN}) reached`, 429);
  }

  // Guardrail: total children
  const totalCount = await sessionStore.countTotalChildren(parentId);
  if (totalCount >= MAX_TOTAL_CHILDREN) {
    return error(`Maximum total children (${MAX_TOTAL_CHILDREN}) reached`, 429);
  }

  // Read parent's canonical user_id from D1 for inheritance
  const parentSession = await sessionStore.get(parentId);
  const parentUserId = parentSession?.userId ?? null;

  // Get parent context from parent DO
  const parentDoId = env.SESSION.idFromName(parentId);
  const parentStub = env.SESSION.get(parentDoId);

  const spawnContextRes = await parentStub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.spawnContext), undefined, ctx)
  );

  if (!spawnContextRes.ok) {
    return error("Failed to get parent session context", 500);
  }

  const spawnContext = (await spawnContextRes.json()) as SpawnContext;

  // Guardrail: same-repo — reject if either field doesn't match parent
  if (
    (body.repoOwner && body.repoOwner.toLowerCase() !== spawnContext.repoOwner.toLowerCase()) ||
    (body.repoName && body.repoName.toLowerCase() !== spawnContext.repoName.toLowerCase())
  ) {
    return error("Child sessions must use the same repository as the parent", 403);
  }

  // Create child session (same pattern as handleCreateSession)
  const childId = generateId();
  const childDoId = env.SESSION.idFromName(childId);
  const childStub = env.SESSION.get(childDoId);

  // Validate explicit model from the agent; reject invalid names so the agent
  // can self-correct instead of silently falling back to the default model.
  const rawModel = body.model ?? spawnContext.model;
  if (body.model !== undefined && !isValidModel(body.model)) {
    return error(`Invalid model "${body.model}". Valid models: ${VALID_MODELS.join(", ")}`, 400);
  }
  const model = getValidModelOrDefault(rawModel);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : spawnContext.reasoningEffort;

  const childDepth = parentDepth + 1;

  logger.info("Spawning child session", {
    event: "session.spawn_child",
    parent_id: parentId,
    child_id: childId,
    child_depth: childDepth,
    model,
  });

  // Resolve code-server integration setting and sandbox settings for child (same repo as parent)
  const [childCodeServerEnabled, childSandboxSettings] = await Promise.all([
    resolveCodeServerEnabled(env.DB, spawnContext.repoOwner, spawnContext.repoName),
    resolveSandboxSettings(env.DB, spawnContext.repoOwner, spawnContext.repoName),
  ]);

  // Initialize child DO
  const initResponse = await childStub.fetch(
    internalRequest(
      buildSessionInternalUrl(SessionInternalPaths.init),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName: childId,
          repoOwner: spawnContext.repoOwner,
          repoName: spawnContext.repoName,
          repoId: spawnContext.repoId,
          title: body.title,
          model,
          reasoningEffort,
          userId: spawnContext.owner.userId,
          scmLogin: spawnContext.owner.scmLogin,
          scmName: spawnContext.owner.scmName,
          scmEmail: spawnContext.owner.scmEmail,
          scmTokenEncrypted: spawnContext.owner.scmAccessTokenEncrypted,
          scmRefreshTokenEncrypted: spawnContext.owner.scmRefreshTokenEncrypted,
          scmTokenExpiresAt: spawnContext.owner.scmTokenExpiresAt,
          scmUserId: spawnContext.owner.scmUserId,
          branch: spawnContext.baseBranch ?? "main",
          parentSessionId: parentId,
          spawnSource: "agent",
          spawnDepth: childDepth,
          codeServerEnabled: childCodeServerEnabled,
          sandboxSettings: childSandboxSettings,
        }),
      },
      ctx
    )
  );

  if (!initResponse.ok) {
    return error("Failed to create child session", 500);
  }

  // Store in D1 index
  const now = Date.now();
  await sessionStore.create({
    id: childId,
    title: body.title,
    repoOwner: spawnContext.repoOwner,
    repoName: spawnContext.repoName,
    model,
    reasoningEffort,
    baseBranch: spawnContext.baseBranch ?? "main",
    status: "created",
    parentSessionId: parentId,
    spawnSource: "agent",
    spawnDepth: childDepth,
    scmLogin: spawnContext.owner.scmLogin || null,
    userId: parentUserId,
    createdAt: now,
    updatedAt: now,
  });

  // Enqueue the prompt on the child DO
  let promptResponse: Response;
  try {
    promptResponse = await childStub.fetch(
      internalRequest(
        buildSessionInternalUrl(SessionInternalPaths.prompt),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: body.prompt,
            authorId: spawnContext.owner.userId,
            source: "agent",
          }),
        },
        ctx
      )
    );
  } catch (enqueueError) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
      error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  if (!promptResponse.ok) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      prompt_status: promptResponse.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  // Notify parent session so connected clients can refresh child list
  ctx.executionCtx?.waitUntil(
    parentStub
      .fetch(
        internalRequest(
          buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId: childId,
              status: "created",
              title: body.title,
            }),
          },
          ctx
        )
      )
      .catch((err) => {
        logger.error("session.notify_parent_spawn.failed", { error: err });
      })
  );

  return json({ sessionId: childId, status: "created" }, 201);
}

async function handleListChildren(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const sessionStore = new SessionIndexStore(env.DB);
  const children = await sessionStore.listByParent(parentId);

  return json({ children });
}

async function handleGetChild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(env.DB);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  // Fetch child summary from child DO
  const childDoId = env.SESSION.idFromName(childId);
  const childStub = env.SESSION.get(childDoId);

  const response = await childStub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.childSummary), undefined, ctx)
  );

  return response;
}

async function handleCancelChild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(env.DB);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  // Cancel via child DO
  const childDoId = env.SESSION.idFromName(childId);
  const childStub = env.SESSION.get(childDoId);

  const response = await childStub.fetch(
    internalRequest(buildSessionInternalUrl(SessionInternalPaths.cancel), { method: "POST" }, ctx)
  );

  return response;
}
