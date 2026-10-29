import { z } from "zod";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import { createLogger } from "../logger";
import type { GetRepositoryConfig, ListBranchesContext, ListBranchesResult } from "./types";

export const BRANCHES_CACHE_FRESH_MS = 60 * 1000;
export const BRANCHES_CACHE_TTL_MS = 60 * 60 * 1000;

export function branchesCacheKey(owner: string, name: string): string {
  return `repos:branches:v1:${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export const cachedBranchesListSchema = z.object({
  branches: z.array(z.object({ name: z.string() })),
  cachedAt: z.string(),
  scmIdentity: z.string(),
  freshUntil: z.number(),
});

export type CachedBranchesList = z.infer<typeof cachedBranchesListSchema>;

export interface BranchCacheConfig {
  store: CacheStore;
  getIdentity: () => Promise<string>;
}

const logger = createLogger("source-control:branch-cache");
// Coalesce within this isolate; duplicates across isolates are still possible and harmless.
const refreshesInFlight = new Map<string, Promise<CachedBranchesList>>();

/** Provider-neutral branch caching; HTTP admission and response handling stay with the caller. */
export async function listBranchesWithCache(
  repository: GetRepositoryConfig,
  fetchBranches: () => Promise<{ name: string }[]>,
  context: ListBranchesContext,
  cache?: BranchCacheConfig
): Promise<ListBranchesResult> {
  if (!cache) {
    const branches = await context.metrics.time("scm_api", fetchBranches);
    return { branches, cached: false, cachedAt: new Date().toISOString() };
  }

  const { owner, name } = repository;
  const cacheKey = branchesCacheKey(owner, name);
  const scmIdentity = await cache.getIdentity();
  let cached: CachedBranchesList | null = null;
  try {
    const result = cachedBranchesListSchema.safeParse(
      await context.metrics.time("kv_read", () => cache.store.get(cacheKey, "json"))
    );
    cached = result.success ? result.data : null;
  } catch (e) {
    logger.warn("Failed to read branches cache", {
      trace_id: context.traceId,
      error: e instanceof Error ? e : String(e),
    });
  }

  const fetchAndCache = async (): Promise<CachedBranchesList> => {
    const scmStartedAt = Date.now();
    const branches = await context.metrics.time("scm_api", fetchBranches).finally(() => {
      logger.info("repos_branches_cache.fetch", {
        event: "repos_branches_cache.fetch",
        trace_id: context.traceId,
        repo_owner: owner,
        repo_name: name,
        scm_api_ms: Date.now() - scmStartedAt,
      });
    });
    const entry: CachedBranchesList = {
      branches,
      cachedAt: new Date().toISOString(),
      scmIdentity,
      freshUntil: Date.now() + BRANCHES_CACHE_FRESH_MS,
    };
    try {
      await cache.store.put(cacheKey, JSON.stringify(entry), { ttlMs: BRANCHES_CACHE_TTL_MS });
    } catch (e) {
      logger.warn("Failed to write branches cache", {
        trace_id: context.traceId,
        error: e instanceof Error ? e : String(e),
      });
    }
    return entry;
  };

  const refresh = (): Promise<CachedBranchesList> => {
    const refreshKey = `${scmIdentity}:${cacheKey}`;
    const inFlight = refreshesInFlight.get(refreshKey);
    if (inFlight) return inFlight;
    const pending = fetchAndCache().finally(() => {
      refreshesInFlight.delete(refreshKey);
    });
    refreshesInFlight.set(refreshKey, pending);
    return pending;
  };

  if (cached?.scmIdentity === scmIdentity) {
    if (Date.now() >= cached.freshUntil) {
      context.backgroundTasks.submit(
        () =>
          refresh().catch((e) => {
            logger.warn("Failed to refresh branches cache", {
              trace_id: context.traceId,
              error: e instanceof Error ? e : String(e),
              repo_owner: owner,
              repo_name: name,
            });
          }),
        { name: "repos_branches_cache.refresh", context: { trace_id: context.traceId } }
      );
    }
    return { branches: cached.branches, cached: true, cachedAt: cached.cachedAt };
  }

  // Share one refresh with the host so a disconnected caller still fills the cache.
  const pending = refresh();
  context.backgroundTasks.submit(() => pending, {
    name: "repos_branches_cache.refresh",
    context: { trace_id: context.traceId },
  });
  const result = await pending;
  return { branches: result.branches, cached: false, cachedAt: result.cachedAt };
}
