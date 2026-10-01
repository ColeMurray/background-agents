/**
 * Repository listing and metadata routes and handlers.
 */

import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { repositoryParams } from "./repository-params";
import { RepoMetadataStore } from "../db/repo-metadata";
import type { Env } from "../types";
import { repoMetadataSchema } from "@open-inspect/shared/types/repository-catalog";
import {
  REPOS_CACHE_KEY,
  cachedReposListSchema,
  refreshReposCache,
  reposCacheIdentity,
  type CachedReposList,
} from "../repos/cache";
import { SourceControlProviderError } from "../source-control";
import { createLogger } from "../logger";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  createRouteSourceControlProvider,
  requirePermission,
} from "./shared";

export { REPOS_CACHE_KEY, reposCacheIdentity } from "../repos/cache";

const logger = createLogger("router:repos");

/**
 * List all repositories accessible via the SCM provider's app-level credentials.
 *
 * Uses stale-while-revalidate caching:
 * - Fresh cache (< 5 min old): return immediately
 * - Stale cache (5 min – 1 hr): return immediately, revalidate in background
 * - No cache: fetch synchronously (first load or after 1 hr KV expiry)
 *
 * This prevents slow API pagination from blocking the Worker
 * isolate and causing head-of-line blocking for other requests.
 */
async function handleListRepos(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const cacheStore = env.REPOS_CACHE;
  const scmIdentity = await reposCacheIdentity(env);

  // Read from KV cache
  let cached: CachedReposList | null = null;
  try {
    const result = cachedReposListSchema.safeParse(
      await ctx.metrics.time("kv_read", () => cacheStore.get(REPOS_CACHE_KEY, "json"))
    );
    cached = result.success ? result.data : null;
  } catch (e) {
    logger.warn("Failed to read repos cache", { error: e instanceof Error ? e : String(e) });
  }

  if (cached?.scmIdentity === scmIdentity) {
    const isFresh = cached.freshUntil && Date.now() < cached.freshUntil;

    if (!isFresh) {
      // Stale — serve immediately but refresh in background
      logger.info("Serving stale repos cache, refreshing in background", {
        trace_id: ctx.trace_id,
        cached_at: cached.cachedAt,
      });
      ctx.executionCtx.submit(
        () =>
          refreshReposCache(
            env,
            ctx.db,
            createRouteSourceControlProvider(env),
            scmIdentity,
            ctx.trace_id
          ),
        {
          name: "repos_cache.refresh",
          context: { trace_id: ctx.trace_id },
        }
      );
    }

    return json({
      repos: cached.repos,
      cached: true,
      cachedAt: cached.cachedAt,
    });
  }

  // No cache at all — populate synchronously. The refresh is also registered
  // with waitUntil so it outlives this response: a caller that gives up first
  // (the web proxy aborts at CONTROL_PLANE_FETCH_TIMEOUT_MS) would otherwise
  // cancel the Worker before the KV write, leaving the cache empty so the next
  // request repeats the same slow path — a miss that can never self-heal,
  // because the stale-while-revalidate branch above needs an entry to exist.
  // The refresh promise is created once and shared: the factory hands it to
  // waitUntil while the response below awaits the same run.
  const refresh = refreshReposCache(
    env,
    ctx.db,
    createRouteSourceControlProvider(env),
    scmIdentity,
    ctx.trace_id,
    (fn) => ctx.metrics.time("scm_api", fn)
  );
  ctx.executionCtx.submit(() => refresh, {
    name: "repos_cache.refresh",
    context: { trace_id: ctx.trace_id },
  });

  const result = await refresh;
  if (!result.ok) {
    if (result.reason === "not_configured") {
      return error("SCM provider not configured", 500);
    }
    return error("Failed to fetch repositories", 500);
  }

  return json({
    repos: result.repos,
    cached: false,
    cachedAt: result.cachedAt,
  });
}

/**
 * Update metadata for a specific repository.
 * This allows storing custom descriptions, aliases, and channel associations.
 */
async function handleUpdateRepoMetadata(
  request: Request,
  env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  // Parse and validate at the trust boundary: malformed JSON and structurally
  // invalid metadata both take the same 400 path, before any persistence.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error("Invalid repository metadata", 400);
  }
  const parsedBody = repoMetadataSchema.safeParse(rawBody);
  if (!parsedBody.success) return error("Invalid repository metadata", 400);
  // Zod has already validated every field and stripped unknown keys.
  const metadata = parsedBody.data;

  const metadataStore = new RepoMetadataStore(ctx.db);

  try {
    await metadataStore.upsert(owner, name, metadata);
  } catch (e) {
    logger.error("Failed to update repo metadata", {
      error: e instanceof Error ? e : String(e),
    });
    return error("Failed to update metadata", 500);
  }

  try {
    await env.REPOS_CACHE.delete(REPOS_CACHE_KEY);
  } catch (e) {
    logger.warn("Failed to invalidate repos cache", {
      trace_id: ctx.trace_id,
      error: e instanceof Error ? e : String(e),
      repo_owner: owner,
      repo_name: name,
    });
  }

  // Return normalized repo identifier
  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  return json({
    status: "updated",
    repo: normalizedRepo,
    metadata,
  });
}

/**
 * Get metadata for a specific repository.
 */
async function handleGetRepoMetadata(
  request: Request,
  env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const metadataStore = new RepoMetadataStore(ctx.db);

  try {
    const metadata = await metadataStore.get(owner, name);

    return json({
      repo: normalizedRepo,
      metadata: metadata ?? null,
    });
  } catch (e) {
    logger.error("Failed to get repo metadata", { error: e instanceof Error ? e : String(e) });
    return error("Failed to get metadata", 500);
  }
}

/**
 * List branches for a specific repository.
 */
async function handleListBranches(
  _request: Request,
  env: Env,
  params: { owner: string; name: string },
  _ctx: RequestContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  try {
    const provider = createRouteSourceControlProvider(env);
    const branches = await provider.listBranches({ owner, name });
    return json({ branches });
  } catch (e) {
    if (e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus) {
      return error("SCM provider not configured", 500);
    }
    logger.error("Failed to list branches", {
      error: e instanceof Error ? e : String(e),
      repo_owner: owner,
      repo_name: name,
    });
    return error("Failed to list branches", 500);
  }
}

const REPOSITORIES_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("repositories.read"),
});

export const reposRoutes = new Hono<ControlPlaneHonoEnv>();

reposRoutes.get(
  "/repos",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("repositories.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
  }),
  (c) => dispatch(c, handleListRepos)
);
reposRoutes.put(
  "/repos/:owner/:name/metadata",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("repositories.settings.manage"),
  }),
  (c) => dispatch(c, handleUpdateRepoMetadata)
);
reposRoutes.get(
  "/repos/:owner/:name/metadata",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("repositories.read", {
      actorlessGrants: [{ service: "github-bot" }],
    }),
  }),
  (c) => dispatch(c, handleGetRepoMetadata)
);
reposRoutes.get("/repos/:owner/:name/branches", REPOSITORIES_READ, (c) =>
  dispatch(c, handleListBranches)
);
