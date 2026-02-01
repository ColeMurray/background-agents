/**
 * Dynamic repository fetching from the control plane.
 *
 * This module replaces the static REPO_REGISTRY with dynamic fetching
 * from the control plane's GET /repos endpoint, which queries the
 * GitHub App installation to get the list of accessible repositories.
 */

import type { Env, RepoConfig, ControlPlaneRepo, ControlPlaneReposResponse } from "../types";
import { normalizeRepoId } from "../utils/repo";
import { generateInternalToken } from "../utils/internal";
import { createLogger } from "../logger";

const log = createLogger("repos");

/**
 * Fallback repositories if the control plane is unreachable.
 * This ensures the bot doesn't completely break during outages.
 */
const FALLBACK_REPOS: RepoConfig[] = [];

/**
 * Local cache TTL in milliseconds (1 minute).
 * This is shorter than the control plane's 5-minute cache because
 * the slack-bot might be restarted more frequently.
 */
const LOCAL_CACHE_TTL_MS = 60 * 1000;

/**
 * Local in-memory cache for repos.
 */
let localCache: {
  repos: RepoConfig[];
  timestamp: number;
} | null = null;

/**
 * Convert a control plane repo to a RepoConfig.
 * Normalizes identifiers to lowercase for consistent comparison.
 */
function toRepoConfig(repo: ControlPlaneRepo): RepoConfig {
  const normalizedOwner = repo.owner.toLowerCase();
  const normalizedName = repo.name.toLowerCase();

  return {
    id: normalizeRepoId(repo.owner, repo.name),
    owner: normalizedOwner,
    name: normalizedName,
    fullName: `${normalizedOwner}/${normalizedName}`,
    displayName: repo.name, // Keep original casing for display
    description: repo.metadata?.description || repo.description || repo.name,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    aliases: repo.metadata?.aliases,
    keywords: repo.metadata?.keywords,
    channelAssociations: repo.metadata?.channelAssociations,
  };
}

/**
 * Fetch available repositories from the control plane.
 *
 * This function:
 * 1. Checks local in-memory cache first
 * 2. Calls the control plane GET /repos endpoint
 * 3. Falls back to FALLBACK_REPOS if the API fails
 *
 * @param env - Cloudflare Worker environment
 * @returns Array of RepoConfig objects
 */
export async function getAvailableRepos(env: Env, traceId?: string): Promise<RepoConfig[]> {
  // Check local cache first
  if (localCache && Date.now() - localCache.timestamp < LOCAL_CACHE_TTL_MS) {
    return localCache.repos;
  }

  const startTime = Date.now();
  try {
    // Use service binding if available, otherwise fall back to HTTP fetch
    let response: Response;

    // Build headers with auth token if secret is configured
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (env.INTERNAL_CALLBACK_SECRET) {
      const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    if (traceId) {
      headers["x-trace-id"] = traceId;
    }

    if (env.CONTROL_PLANE) {
      response = await env.CONTROL_PLANE.fetch("https://internal/repos", {
        headers,
      });
    } else {
      const url = `${env.CONTROL_PLANE_URL}/repos`;
      response = await fetch(url, {
        headers: {
          ...headers,
          "User-Agent": "open-inspect-slack-bot",
        },
      });
    }

    if (!response.ok) {
      log.error("control_plane.fetch_repos", {
        trace_id: traceId,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return getFromCacheOrFallback(env);
    }

    const data = (await response.json()) as ControlPlaneReposResponse;
    const repos = data.repos.map(toRepoConfig);

    // Update local cache
    localCache = {
      repos,
      timestamp: Date.now(),
    };

    // Also store in KV for persistence across worker restarts
    try {
      await env.SLACK_KV.put("repos:cache", JSON.stringify(repos), {
        expirationTtl: 300, // 5 minutes
      });
    } catch (e) {
      log.warn("kv.put", {
        trace_id: traceId,
        key_prefix: "repos_cache",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    log.info("control_plane.fetch_repos", {
      trace_id: traceId,
      outcome: "success",
      repo_count: repos.length,
      duration_ms: Date.now() - startTime,
    });

    return repos;
  } catch (e) {
    log.error("control_plane.fetch_repos", {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return getFromCacheOrFallback(env);
  }
}

/**
 * Get repos from KV cache or return fallback.
 */
async function getFromCacheOrFallback(env: Env): Promise<RepoConfig[]> {
  try {
    const cached = await env.SLACK_KV.get("repos:cache", "json");
    if (cached && Array.isArray(cached)) {
      log.info("control_plane.fetch_repos", { source: "kv_cache" });
      return cached as RepoConfig[];
    }
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: "repos_cache",
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  log.warn("control_plane.fetch_repos", { source: "fallback" });
  if (FALLBACK_REPOS.length === 0) {
    log.error("control_plane.fetch_repos", {
      error_message:
        "No fallback repos configured and control plane is unavailable. " +
        "Bot will not be able to process requests until control plane is restored.",
    });
  }
  return FALLBACK_REPOS;
}

/**
 * Find a repository by owner and name.
 */
export async function getRepoByFullName(
  env: Env,
  fullName: string,
  traceId?: string
): Promise<RepoConfig | undefined> {
  const repos = await getAvailableRepos(env, traceId);
  return repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
}

/**
 * Find a repository by its ID.
 */
export async function getRepoById(
  env: Env,
  id: string,
  traceId?: string
): Promise<RepoConfig | undefined> {
  const repos = await getAvailableRepos(env, traceId);
  return repos.find((r) => r.id.toLowerCase() === id.toLowerCase());
}

/**
 * Find repositories associated with a Slack channel.
 */
export async function getReposByChannel(
  env: Env,
  channelId: string,
  traceId?: string
): Promise<RepoConfig[]> {
  const repos = await getAvailableRepos(env, traceId);
  return repos.filter((r) => r.channelAssociations?.includes(channelId));
}

/**
 * Build a description string for all available repos.
 * Used in the classification prompt.
 */
export async function buildRepoDescriptions(env: Env, traceId?: string): Promise<string> {
  const repos = await getAvailableRepos(env, traceId);

  if (repos.length === 0) {
    return "No repositories are currently available.";
  }

  return repos
    .map(
      (repo) => `
- **${repo.id}** (${repo.fullName})
  - Description: ${repo.description}
  - Also known as: ${repo.aliases?.join(", ") || "N/A"}
  - Keywords: ${repo.keywords?.join(", ") || "N/A"}
  - Default branch: ${repo.defaultBranch}
  - Private: ${repo.private ? "Yes" : "No"}`
    )
    .join("\n");
}

/**
 * Clear local cache (for testing or forced refresh).
 */
export function clearLocalCache(): void {
  localCache = null;
}
