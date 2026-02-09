/**
 * Hono HTTP Router.
 *
 * Ports all API routes from the Cloudflare Workers router to Hono format.
 * Routes delegate to Rivet actor actions for session-scoped operations
 * and to PostgreSQL stores for global data (sessions index, repo metadata, secrets).
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { Config } from "./config";
import type {
  CreateSessionRequest,
  SessionStatus,
} from "./types";
import {
  SessionIndexStore,
  RepoMetadataStore,
  RepoSecretsStore,
  RepoSecretsValidationError,
  type ListSessionsOptions,
} from "./db/postgres";
import { RedisCache } from "./cache/redis";
import {
  getGitHubAppConfig,
  isGitHubAppConfigured,
  listInstallationRepositories,
  getInstallationRepository,
  type GitHubAppConfig,
} from "./auth/github-app";
import { generateId } from "./auth/crypto";
import { verifyInternalToken } from "./auth/internal";
import { createLogger, parseLogLevel } from "./logger";
import type { RepoMetadata } from "@open-inspect/shared";
import type { ActorRegistry } from "./actors/registry";

const log = createLogger("router");

/** TTL for the repos cache in seconds (5 minutes). */
const REPOS_CACHE_TTL_SECONDS = 300;
const REPOS_CACHE_KEY = "repos:list";

/**
 * Application context that is injected into the router.
 */
export interface AppContext {
  config: Config;
  sessionIndex: SessionIndexStore;
  repoMetadata: RepoMetadataStore;
  repoSecrets: RepoSecretsStore;
  cache: RedisCache;
  registry: ActorRegistry;
}

/**
 * Create the Hono router with all API routes.
 */
export function createRouter(ctx: AppContext): Hono {
  const app = new Hono();

  const { config, sessionIndex, repoMetadata, repoSecrets, cache, registry } = ctx;
  const ghAppConfig = getGitHubAppConfig(config);

  // ==================== Health ====================

  app.get("/health", (c) => {
    return c.json({ status: "ok", deployment: config.deploymentName, timestamp: Date.now() });
  });

  // ==================== Sessions ====================

  /**
   * POST /sessions - Create a new session.
   */
  app.post("/sessions", async (c) => {
    const body = await c.req.json<CreateSessionRequest>();

    if (!body.repoOwner || !body.repoName) {
      return c.json({ error: "repoOwner and repoName are required" }, 400);
    }

    const sessionId = uuidv4();
    const now = Date.now();
    const model = body.model ?? "claude-sonnet-4-5";

    // Create session in the index
    await sessionIndex.create({
      id: sessionId,
      title: body.title ?? null,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      model,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    // Resolve repo info from GitHub App if configured
    let repoDefaultBranch = "main";
    let repoId: number | undefined;
    if (ghAppConfig) {
      try {
        const repoInfo = await getInstallationRepository(
          ghAppConfig,
          body.repoOwner,
          body.repoName,
        );
        if (repoInfo) {
          repoDefaultBranch = repoInfo.defaultBranch;
          repoId = repoInfo.id;
        }
      } catch (err) {
        log.warn("Failed to fetch repo info from GitHub App", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Initialize the actor
    const sessionActor = registry.getActor("session", sessionId);
    await sessionActor.init({
      sessionId,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      repoDefaultBranch,
      repoId,
      title: body.title,
      model,
      reasoningEffort: body.reasoningEffort,
    });

    return c.json({ sessionId, status: "created" as SessionStatus }, 201);
  });

  /**
   * GET /sessions - List sessions.
   */
  app.get("/sessions", async (c) => {
    const options: ListSessionsOptions = {
      status: c.req.query("status") || undefined,
      excludeStatus: c.req.query("excludeStatus") || undefined,
      repoOwner: c.req.query("repoOwner") || undefined,
      repoName: c.req.query("repoName") || undefined,
      limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined,
      offset: c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined,
    };

    const result = await sessionIndex.list(options);
    return c.json(result);
  });

  /**
   * GET /sessions/:id - Get session details.
   */
  app.get("/sessions/:id", async (c) => {
    const id = c.req.param("id");

    try {
      const sessionActor = registry.getActor("session", id);
      const details = await sessionActor.getSessionDetails();

      if (!details) {
        return c.json({ error: "Session not found" }, 404);
      }

      return c.json(details);
    } catch {
      // Fallback to index if actor not found
      const entry = await sessionIndex.get(id);
      if (!entry) {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(entry);
    }
  });

  /**
   * DELETE /sessions/:id - Delete a session.
   */
  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await sessionIndex.delete(id);

    if (!deleted) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({ success: true });
  });

  /**
   * POST /sessions/:id/prompt - Send a prompt to a session.
   */
  app.post("/sessions/:id/prompt", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      content: string;
      authorId?: string;
      source?: string;
      model?: string;
      reasoningEffort?: string;
    }>();

    if (!body.content) {
      return c.json({ error: "content is required" }, 400);
    }

    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.enqueuePrompt({
      authorId: body.authorId ?? "api",
      content: body.content,
      source: (body.source ?? "web") as "web" | "slack" | "extension" | "github",
      model: body.model,
      reasoningEffort: body.reasoningEffort,
    });

    // Update status in the index
    await sessionIndex.updateStatus(id, "active");

    return c.json(result);
  });

  /**
   * POST /sessions/:id/stop - Stop session execution.
   */
  app.post("/sessions/:id/stop", async (c) => {
    const id = c.req.param("id");
    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.stop();
    return c.json(result);
  });

  /**
   * GET /sessions/:id/events - Get session events.
   */
  app.get("/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const cursor = c.req.query("cursor") || undefined;
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const types = c.req.query("types")?.split(",") || undefined;

    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.getEvents({ cursor, limit, types });
    return c.json(result);
  });

  /**
   * GET /sessions/:id/artifacts - Get session artifacts.
   */
  app.get("/sessions/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    const sessionActor = registry.getActor("session", id);
    const artifacts = await sessionActor.getArtifacts();
    return c.json({ artifacts });
  });

  /**
   * GET /sessions/:id/participants - Get session participants.
   */
  app.get("/sessions/:id/participants", async (c) => {
    const id = c.req.param("id");
    const sessionActor = registry.getActor("session", id);
    const participants = await sessionActor.getParticipants();
    return c.json({ participants });
  });

  /**
   * GET /sessions/:id/messages - Get session messages.
   */
  app.get("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const status = c.req.query("status") || undefined;

    const sessionActor = registry.getActor("session", id);
    const messages = await sessionActor.getMessages(status ? { status } : undefined);
    return c.json({ messages });
  });

  /**
   * POST /sessions/:id/pr - Create a pull request.
   */
  app.post("/sessions/:id/pr", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      title: string;
      body?: string;
      baseBranch?: string;
      headBranch?: string;
      draft?: boolean;
    }>();

    if (!body.title) {
      return c.json({ error: "title is required" }, 400);
    }

    // Get session state from the actor
    const sessionActor = registry.getActor("session", id);
    const details = await sessionActor.getSessionDetails();

    if (!details) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (!details.branchName) {
      return c.json({ error: "No branch available for PR creation" }, 400);
    }

    // PR creation requires the source-control provider, which is set up
    // at the server level and passed through context. For now, return
    // the information needed to create the PR.
    return c.json({
      sessionId: id,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      headBranch: body.headBranch ?? details.branchName,
      baseBranch: body.baseBranch ?? details.repoDefaultBranch,
      title: body.title,
      body: body.body,
      draft: body.draft,
      status: "pending",
    });
  });

  /**
   * POST /sessions/:id/ws-token - Generate a WebSocket authentication token.
   */
  app.post("/sessions/:id/ws-token", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ participantId?: string }>();

    const participantId = body.participantId ?? "anonymous";

    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.generateWsToken({ participantId });
    return c.json(result);
  });

  /**
   * POST /sessions/:id/archive - Archive a session.
   */
  app.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");

    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.archive();

    if (result.success) {
      await sessionIndex.updateStatus(id, "archived");
    }

    return c.json(result);
  });

  /**
   * POST /sessions/:id/unarchive - Unarchive a session.
   */
  app.post("/sessions/:id/unarchive", async (c) => {
    const id = c.req.param("id");

    const sessionActor = registry.getActor("session", id);
    const result = await sessionActor.unarchive();

    if (result.success) {
      await sessionIndex.updateStatus(id, "active");
    }

    return c.json(result);
  });

  /**
   * POST /sessions/:id/sandbox-event - Receive events from sandbox pods.
   *
   * This is the callback endpoint that sandbox pods use to send events
   * back to the control plane. Requires internal API authentication.
   */
  app.post("/sessions/:id/sandbox-event", async (c) => {
    const authHeader = c.req.header("Authorization") ?? null;
    const isValid = await verifyInternalToken(authHeader, config.internalApiSecret);
    if (!isValid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param("id");
    const event = await c.req.json();

    const sessionActor = registry.getActor("session", id);
    await sessionActor.handleSandboxEvent(event);

    return c.json({ success: true });
  });

  // ==================== Repositories ====================

  /**
   * GET /repos - List accessible repositories.
   *
   * Returns repositories accessible to the GitHub App installation,
   * enriched with custom metadata from the database.
   * Cached in Redis with a 5-minute TTL.
   */
  app.get("/repos", async (c) => {
    if (!ghAppConfig) {
      return c.json({ error: "GitHub App not configured" }, 503);
    }

    // Check cache
    const cached = await cache.get<unknown>(REPOS_CACHE_KEY);
    if (cached) {
      return c.json(cached);
    }

    try {
      const { repos, timing } = await listInstallationRepositories(ghAppConfig);

      // Fetch metadata for all repos
      const metadataMap = await repoMetadata.getBatch(
        repos.map((r) => ({ owner: r.owner, name: r.name })),
      );

      // Enrich repos with metadata
      const enriched = repos.map((repo) => {
        const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
        const meta = metadataMap.get(key);
        return {
          ...repo,
          metadata: meta ?? undefined,
        };
      });

      const result = { repos: enriched, timing };

      // Cache the result
      await cache.set(REPOS_CACHE_KEY, result, REPOS_CACHE_TTL_SECONDS);

      return c.json(result);
    } catch (err) {
      log.error("Failed to list repositories", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { error: "Failed to list repositories" },
        500,
      );
    }
  });

  /**
   * GET /repos/:owner/:name/metadata - Get repository metadata.
   */
  app.get("/repos/:owner/:name/metadata", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");

    const metadata = await repoMetadata.get(owner, name);
    return c.json({ metadata: metadata ?? {} });
  });

  /**
   * PUT /repos/:owner/:name/metadata - Update repository metadata.
   */
  app.put("/repos/:owner/:name/metadata", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const body = await c.req.json<RepoMetadata>();

    await repoMetadata.upsert(owner, name, body);

    // Invalidate repos cache
    await cache.delete(REPOS_CACHE_KEY);

    return c.json({ success: true });
  });

  // ==================== Repo Secrets ====================

  /**
   * GET /repos/:owner/:name/secrets - List secret keys (values never exposed).
   */
  app.get("/repos/:owner/:name/secrets", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");

    // We need the repo ID to look up secrets. Resolve from GitHub App.
    const repoId = await resolveRepoId(ghAppConfig, owner, name);
    if (repoId === null) {
      return c.json({ error: "Repository not found or not accessible" }, 404);
    }

    const secrets = await repoSecrets.listSecretKeys(repoId);
    return c.json({ secrets });
  });

  /**
   * PUT /repos/:owner/:name/secrets - Upsert secrets (batch).
   */
  app.put("/repos/:owner/:name/secrets", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const body = await c.req.json<{ secrets: Record<string, string> }>();

    if (!body.secrets || typeof body.secrets !== "object") {
      return c.json({ error: "secrets object is required" }, 400);
    }

    const repoId = await resolveRepoId(ghAppConfig, owner, name);
    if (repoId === null) {
      return c.json({ error: "Repository not found or not accessible" }, 404);
    }

    try {
      const result = await repoSecrets.setSecrets(repoId, owner, name, body.secrets);
      return c.json(result);
    } catch (err) {
      if (err instanceof RepoSecretsValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  /**
   * DELETE /repos/:owner/:name/secrets/:key - Delete a single secret.
   */
  app.delete("/repos/:owner/:name/secrets/:key", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const key = c.req.param("key");

    const repoId = await resolveRepoId(ghAppConfig, owner, name);
    if (repoId === null) {
      return c.json({ error: "Repository not found or not accessible" }, 404);
    }

    const deleted = await repoSecrets.deleteSecret(repoId, key);
    if (!deleted) {
      return c.json({ error: "Secret not found" }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}

// ==================== Helpers ====================

/**
 * Resolve a GitHub repository ID from the App installation.
 * Returns null if the repo is not accessible.
 */
async function resolveRepoId(
  ghAppConfig: GitHubAppConfig | null,
  owner: string,
  name: string,
): Promise<number | null> {
  if (!ghAppConfig) return null;

  try {
    const repo = await getInstallationRepository(ghAppConfig, owner, name);
    return repo?.id ?? null;
  } catch {
    return null;
  }
}
