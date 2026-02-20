/**
 * Dynamic repository fetching from the control plane.
 * Same pattern as slack-bot: local cache + KV cache + fallback.
 */

import type { Env, RepoConfig, ControlPlaneRepo, ControlPlaneReposResponse } from "../types";
import { generateInternalToken } from "../utils/internal";
import { createLogger } from "../logger";

const log = createLogger("repos");

const LOCAL_CACHE_TTL_MS = 60 * 1000;

let localCache: {
  repos: RepoConfig[];
  timestamp: number;
} | null = null;

function toRepoConfig(repo: ControlPlaneRepo): RepoConfig {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  return {
    id: `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`,
    displayName: repo.name,
    description: repo.metadata?.description || repo.description || repo.name,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    aliases: repo.metadata?.aliases,
    keywords: repo.metadata?.keywords,
  };
}

export async function getAvailableRepos(env: Env, traceId?: string): Promise<RepoConfig[]> {
  if (localCache && Date.now() - localCache.timestamp < LOCAL_CACHE_TTL_MS) {
    return localCache.repos;
  }

  const startTime = Date.now();
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.INTERNAL_CALLBACK_SECRET) {
      const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (traceId) headers["x-trace-id"] = traceId;

    const response = await env.CONTROL_PLANE.fetch("https://internal/repos", { headers });

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

    localCache = { repos, timestamp: Date.now() };

    try {
      await env.LINEAR_KV.put("repos:cache", JSON.stringify(repos), { expirationTtl: 300 });
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

async function getFromCacheOrFallback(env: Env): Promise<RepoConfig[]> {
  try {
    const cached = await env.LINEAR_KV.get("repos:cache", "json");
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

  log.error("control_plane.fetch_repos", {
    error_message: "No repos available from any source.",
  });
  return [];
}

export async function buildRepoDescriptions(env: Env, traceId?: string): Promise<string> {
  const repos = await getAvailableRepos(env, traceId);
  if (repos.length === 0) return "No repositories are currently available.";

  return repos
    .map(
      (repo) => `- **${repo.id}** (${repo.fullName})
  - Description: ${repo.description}
  - Also known as: ${repo.aliases?.join(", ") || "N/A"}
  - Keywords: ${repo.keywords?.join(", ") || "N/A"}
  - Default branch: ${repo.defaultBranch}
  - Private: ${repo.private ? "Yes" : "No"}`
    )
    .join("\n");
}
