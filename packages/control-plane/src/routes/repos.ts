/**
 * Repository listing and metadata routes and handlers.
 */

import { RepoMetadataStore } from "../db/repo-metadata";
import type { Env } from "../types";
import type {
  EnrichedRepository,
  InstallationRepository,
  RepoMetadata,
} from "@open-inspect/shared";
import { SourceControlProviderError } from "../source-control";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  createRouteSourceControlProvider,
} from "./shared";

const logger = createLogger("router:repos");

const REPOS_CACHE_KEY = "repos:list";
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

/**
 * Fetch repos via the source control provider, enrich with D1 metadata, and write to KV cache.
 * Runs either in the foreground (cache miss) or background (stale-while-revalidate).
 */
async function refreshReposCache(env: Env, traceId?: string): Promise<void> {
  const provider = createRouteSourceControlProvider(env);

  let repos: InstallationRepository[];
  try {
    repos = await provider.listRepositories();

    logger.info("Repo fetch completed", {
      trace_id: traceId,
      total_repos: repos.length,
    });
  } catch (e) {
    if (e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus) {
      logger.warn("SCM provider not configured, skipping repo refresh", {
        trace_id: traceId,
      });
      return;
    }
    logger.error("Failed to list installation repositories (background refresh)", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
    return;
  }

  const metadataStore = new RepoMetadataStore(env.DB);
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
    await env.REPOS_CACHE.put(
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
  // Read from KV cache
  let cached: CachedReposList | null = null;
  try {
    cached = await ctx.metrics.time("kv_read", () =>
      env.REPOS_CACHE.get<CachedReposList>(REPOS_CACHE_KEY, "json")
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
      ctx.executionCtx.waitUntil(refreshReposCache(env, ctx.trace_id));
    }

    return json({
      repos: cached.repos,
      cached: true,
      cachedAt: cached.cachedAt,
    });
  }

  // No cache at all — must fetch synchronously
  const provider = createRouteSourceControlProvider(env);

  let repos: InstallationRepository[];
  try {
    repos = await ctx.metrics.time("scm_api", () => provider.listRepositories());
  } catch (e) {
    if (e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus) {
      return error("SCM provider not configured", 500);
    }
    logger.error("Failed to list installation repositories", {
      error: e instanceof Error ? e : String(e),
    });
    return error("Failed to fetch repositories", 500);
  }

  logger.info("Repo fetch completed", {
    trace_id: ctx.trace_id,
    total_repos: repos.length,
  });

  const metadataStore = new RepoMetadataStore(env.DB);
  let metadataMap: Map<string, RepoMetadata>;
  try {
    metadataMap = await metadataStore.getBatch(
      repos.map((r) => ({ owner: r.owner, name: r.name }))
    );
  } catch (e) {
    logger.warn("Failed to fetch repo metadata batch", {
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
    await ctx.metrics.time("kv_write", () =>
      env.REPOS_CACHE.put(
        REPOS_CACHE_KEY,
        JSON.stringify({ repos: enrichedRepos, cachedAt, freshUntil }),
        { expirationTtl: REPOS_CACHE_KV_TTL_SECONDS }
      )
    );
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

  const metadataStore = new RepoMetadataStore(env.DB);

  try {
    await metadataStore.upsert(owner, name, metadata);

    // Invalidate the KV repos cache so next fetch includes updated metadata
    await env.REPOS_CACHE.delete(REPOS_CACHE_KEY);

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

  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const metadataStore = new RepoMetadataStore(env.DB);

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
  const owner = match.groups?.owner;
  const name = match.groups?.name;

  if (!owner || !name) {
    return error("Owner and name are required");
  }

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
