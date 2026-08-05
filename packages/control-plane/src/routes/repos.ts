/**
 * Repository listing and metadata routes and handlers.
 */

import { RepoMetadataStore } from "../db/repo-metadata";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  repoMetadataSchema,
  type EnrichedRepository,
  type InstallationRepository,
  type RepoMetadata,
} from "@open-inspect/shared/types/repository-catalog";
import { SourceControlProviderError } from "../source-control";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  extractRepoParams,
  createRouteSourceControlProvider,
} from "./shared";

const logger = createLogger("router:repos");

const REPOS_CACHE_KEY = "repos:list:v2";
const REPOS_CACHE_FRESH_MS = 5 * 60 * 1000; // Serve without revalidation for 5 minutes
const REPOS_CACHE_KV_TTL_SECONDS = 3600; // Keep stale data in KV for 1 hour

/**
 * Cached repos list structure stored in KV.
 */
interface CachedReposList {
  repos: EnrichedRepository[];
  cachedAt: string;
  /** Epoch ms — cache is considered fresh until this time. Missing in entries cached before this field was added. */
  freshUntil?: number;
}

type ReposRefreshResult =
  | { ok: true; repos: EnrichedRepository[]; cachedAt: string }
  | { ok: false; reason: "not_configured" | "fetch_failed" };

/** Times the SCM call when a request context is available; identity otherwise. */
type ScmApiTimer = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Fetch repos via the source control provider, enrich with D1 metadata, and write to KV cache.
 * Runs either in the foreground (cache miss) or background (stale-while-revalidate).
 */
async function refreshReposCache(
  env: Env,
  db: SqlDatabase,
  traceId?: string,
  timeScmApi: ScmApiTimer = (fn) => fn()
): Promise<ReposRefreshResult> {
  const provider = createRouteSourceControlProvider(env);
  const cacheStore = createKvCacheStore(env.REPOS_CACHE);

  let repos: InstallationRepository[];
  try {
    repos = await timeScmApi(() => provider.listRepositories());

    logger.info("Repo fetch completed", {
      trace_id: traceId,
      total_repos: repos.length,
    });
  } catch (e) {
    if (e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus) {
      logger.warn("SCM provider not configured, skipping repo refresh", {
        trace_id: traceId,
      });
      return { ok: false, reason: "not_configured" };
    }
    logger.error("Failed to list installation repositories (background refresh)", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
    return { ok: false, reason: "fetch_failed" };
  }

  const metadataStore = new RepoMetadataStore(db);
  let metadataMap: Map<string, RepoMetadata>;
  try {
    metadataMap = await metadataStore.getBatch(
      repos.map((r) => ({ owner: r.owner, name: r.name }))
    );
  } catch (e) {
    logger.warn("Failed to fetch repo metadata batch (background refresh)", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
    metadataMap = new Map();
  }

  const enrichedRepos: EnrichedRepository[] = repos.map((repo) => {
    const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    const metadata = metadataMap.get(key);
    return metadata ? { ...repo, metadata } : repo;
  });

  const cachedAt = new Date().toISOString();
  const freshUntil = Date.now() + REPOS_CACHE_FRESH_MS;
  try {
    await cacheStore.put(
      REPOS_CACHE_KEY,
      JSON.stringify({ repos: enrichedRepos, cachedAt, freshUntil }),
      { expirationTtl: REPOS_CACHE_KV_TTL_SECONDS }
    );
    logger.info("Repos cache refreshed", {
      trace_id: traceId,
      repo_count: enrichedRepos.length,
    });
  } catch (e) {
    logger.warn("Failed to write repos cache", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
  }

  return { ok: true, repos: enrichedRepos, cachedAt };
}

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
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const cacheStore = createKvCacheStore(env.REPOS_CACHE);

  // Read from KV cache
  let cached: CachedReposList | null = null;
  try {
    cached = await ctx.metrics.time("kv_read", () =>
      cacheStore.get<CachedReposList>(REPOS_CACHE_KEY, "json")
    );
  } catch (e) {
    logger.warn("Failed to read repos cache", { error: e instanceof Error ? e : String(e) });
  }

  if (cached) {
    const isFresh = cached.freshUntil && Date.now() < cached.freshUntil;

    if (!isFresh && ctx.executionCtx) {
      // Stale — serve immediately but refresh in background
      logger.info("Serving stale repos cache, refreshing in background", {
        trace_id: ctx.trace_id,
        cached_at: cached.cachedAt,
      });
      ctx.executionCtx.waitUntil(refreshReposCache(env, ctx.db, ctx.trace_id));
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
  const refresh = refreshReposCache(env, ctx.db, ctx.trace_id, (fn) =>
    ctx.metrics.time("scm_api", fn)
  );
  ctx.executionCtx?.waitUntil(refresh);

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

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
    await createKvCacheStore(env.REPOS_CACHE).delete(REPOS_CACHE_KEY);
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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

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
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

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

export const reposRoutes: Route[] = [
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
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/branches"),
    handler: handleListBranches,
  },
];
