import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  enrichedRepositorySchema,
  type EnrichedRepository,
  type InstallationRepository,
  type RepoMetadata,
} from "@open-inspect/shared/types/repository-catalog";
import { z } from "zod";
import { RepoMetadataStore } from "../db/repo-metadata";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { resolveScmProviderFromEnv } from "../source-control/config";
import { SourceControlProviderError } from "../source-control/errors";
import { createSourceControlProviderFromEnv } from "../source-control/provider-from-env";
import type { SourceControlProvider } from "../source-control/types";
import type { Env } from "../types";

const logger = createLogger("repos:cache");

export const REPOS_CACHE_KEY = "repos:list:v3";
const REPOS_CACHE_FRESH_MS = 5 * 60 * 1000;
const REPOS_CACHE_KV_TTL_SECONDS = 3600;

export async function reposCacheIdentity(
  env: Pick<
    Env,
    "SCM_PROVIDER" | "GITHUB_APP_INSTALLATION_ID" | "GITLAB_NAMESPACE" | "GITLAB_ACCESS_TOKEN"
  >
): Promise<string> {
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  let identity: string[] = [provider];
  if (provider === "github") identity = [provider, env.GITHUB_APP_INSTALLATION_ID ?? ""];
  if (provider === "gitlab") {
    identity = [provider, env.GITLAB_NAMESPACE ?? "", env.GITLAB_ACCESS_TOKEN ?? ""];
  }
  return await sha256Hex(JSON.stringify(identity));
}

export const cachedReposListSchema = z.object({
  repos: z.array(enrichedRepositorySchema),
  cachedAt: z.string(),
  scmIdentity: z.string(),
  // Missing in entries cached before this field was added.
  freshUntil: z.number().optional(),
});

export type CachedReposList = z.infer<typeof cachedReposListSchema>;

/**
 * Read the installation catalog without fetching, minting credentials, or writing to cache.
 * Stale entries are usable while present in KV because repository IDs are stable.
 */
export async function readCachedInstallationRepositories(
  env: Pick<
    Env,
    | "REPOS_CACHE"
    | "SCM_PROVIDER"
    | "GITHUB_APP_INSTALLATION_ID"
    | "GITLAB_NAMESPACE"
    | "GITLAB_ACCESS_TOKEN"
  >
): Promise<InstallationRepository[]> {
  const scmIdentity = await reposCacheIdentity(env);
  let raw: unknown;
  try {
    raw = await env.REPOS_CACHE.get(REPOS_CACHE_KEY, "json");
  } catch (e) {
    throw new SourceControlProviderError(
      "Failed to read installation repository catalog cache",
      "permanent",
      undefined,
      e instanceof Error ? e : undefined
    );
  }

  const cached = cachedReposListSchema.safeParse(raw);
  if (!cached.success) {
    throw new SourceControlProviderError(
      "Installation repository catalog cache is missing or malformed",
      "permanent"
    );
  }
  if (cached.data.scmIdentity !== scmIdentity) {
    throw new SourceControlProviderError(
      "Installation repository catalog cache does not match SCM configuration",
      "permanent"
    );
  }

  return cached.data.repos;
}

export type ReposRefreshResult =
  | { ok: true; repos: EnrichedRepository[]; cachedAt: string }
  | { ok: false; reason: "not_configured" | "fetch_failed" };

/** Times the SCM call when a request context is available; identity otherwise. */
export type ScmApiTimer = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Fetch repos via the source control provider, enrich with D1 metadata, and write to KV cache.
 * Runs either in the foreground (cache miss) or background (stale-while-revalidate).
 */
export async function refreshReposCache(
  env: Pick<Env, "REPOS_CACHE">,
  db: SqlDatabase,
  provider: Pick<SourceControlProvider, "listRepositories">,
  scmIdentity: string,
  traceId?: string,
  timeScmApi: ScmApiTimer = (fn) => fn()
): Promise<ReposRefreshResult> {
  const cacheStore = env.REPOS_CACHE;

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
      JSON.stringify({ repos: enrichedRepos, cachedAt, scmIdentity, freshUntil }),
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
 * Catalog for resolving legacy NULL repository IDs in credential scopes. Reads the
 * cache first; on a miss, mismatch or read failure, refreshes it in the foreground.
 * The cache otherwise expires an hour after the repository list was last loaded, which
 * would fail legacy sessions closed indefinitely.
 */
export async function loadInstallationRepositories(
  env: Env,
  db: SqlDatabase
): Promise<InstallationRepository[]> {
  try {
    return await readCachedInstallationRepositories(env);
  } catch (e) {
    logger.info("Installation repository catalog cache unusable, refreshing", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const result = await refreshReposCache(
    env,
    db,
    createSourceControlProviderFromEnv(env),
    await reposCacheIdentity(env)
  );
  if (!result.ok) {
    throw new SourceControlProviderError(
      "Failed to load installation repository catalog",
      result.reason === "not_configured" ? "permanent" : "transient"
    );
  }
  return result.repos;
}
