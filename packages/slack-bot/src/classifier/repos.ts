/**
 * Dynamic repository fetching from the control plane.
 *
 * This module replaces the static REPO_REGISTRY with dynamic fetching
 * from the control plane's GET /repos endpoint, which queries the
 * GitHub App installation to get the list of accessible repositories.
 */

import type { Env, RepoConfig, ControlPlaneRepo, ControlPlaneReposResponse } from "../types";
import { normalizeRepoId } from "../utils/repo";
import {
  buildInternalAuthHeaders,
  createKvCacheStore,
  normalizeRoutingRules,
  type SlackGlobalConfig,
  type SlackRoutingRule,
} from "@open-inspect/shared";
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
 * Expiration for the shared KV caches (repos + routing rules), in seconds —
 * the unit Cloudflare KV's `expirationTtl` expects.
 */
const KV_CACHE_TTL_SECONDS = 300;

/**
 * Local in-memory cache for repos.
 */
let localCache: {
  repos: RepoConfig[];
  timestamp: number;
} | null = null;

const ROUTING_RULES_CACHE_KEY = "slack:routing-rules";

const WATCHED_CHANNELS_CACHE_KEY = "slack:watched-channels";

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
 * Issue an authenticated GET to the control plane, preferring the service
 * binding and falling back to URL-based fetch. Centralizes the internal-auth
 * headers and binding-vs-URL switch shared by every control-plane read.
 */
async function controlPlaneFetch(env: Env, path: string, traceId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
  return env.CONTROL_PLANE
    ? env.CONTROL_PLANE.fetch(`https://internal${path}`, { headers })
    : fetch(`${env.CONTROL_PLANE_URL}${path}`, {
        headers: { ...headers, "User-Agent": "open-inspect-slack-bot" },
      });
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
    const response = await controlPlaneFetch(env, "/repos", traceId);

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
      await createKvCacheStore(env.SLACK_KV).put("repos:cache", JSON.stringify(repos), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
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
    const cached = await createKvCacheStore(env.SLACK_KV).get("repos:cache", "json");
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

// ─── Cached control-plane list fetch (shared engine) ─────────────────────────

/** A mutable in-memory cache slot for one list resource. */
interface CacheSlot<T> {
  read(): { value: T; timestamp: number } | null;
  write(value: T): void;
  clear(): void;
}

function makeCacheSlot<T>(): CacheSlot<T> {
  let slot: { value: T; timestamp: number } | null = null;
  return {
    read: () => slot,
    write: (value) => {
      slot = { value, timestamp: Date.now() };
    },
    clear: () => {
      slot = null;
    },
  };
}

/**
 * A control-plane list resource fetched through the two-tier cache: in-memory
 * (LOCAL_CACHE_TTL_MS) → control plane → KV last-known-good. On a fetch failure
 * it returns whatever `fromCache` yields from KV (empty on a cold miss), so each
 * resource decides via that whether the failure mode is fail-open or fail-closed.
 */
interface CachedListResource<TItem> {
  path: string;
  kvKey: string;
  /** Log event name for fetch failures. */
  logEvent: string;
  /** `key_prefix` used in KV error logs. */
  kvKeyPrefix: string;
  slot: CacheSlot<TItem[]>;
  /** Extract the list from a fresh control-plane JSON response. */
  fromResponse: (json: unknown) => TItem[];
  /** Extract the list from a KV-cached JSON value (array or otherwise). */
  fromCache: (cached: unknown) => TItem[];
}

async function fetchCachedList<TItem>(
  env: Env,
  traceId: string | undefined,
  resource: CachedListResource<TItem>
): Promise<TItem[]> {
  const cached = resource.slot.read();
  if (cached && Date.now() - cached.timestamp < LOCAL_CACHE_TTL_MS) {
    return cached.value;
  }

  const startTime = Date.now();
  try {
    const response = await controlPlaneFetch(env, resource.path, traceId);

    if (!response.ok) {
      log.warn(resource.logEvent, {
        trace_id: traceId,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return readListFromKv(env, resource);
    }

    const items = resource.fromResponse(await response.json());
    resource.slot.write(items);

    try {
      await createKvCacheStore(env.SLACK_KV).put(resource.kvKey, JSON.stringify(items), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
    } catch (e) {
      log.warn("kv.put", {
        trace_id: traceId,
        key_prefix: resource.kvKeyPrefix,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    return items;
  } catch (e) {
    log.warn(resource.logEvent, {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return readListFromKv(env, resource);
  }
}

async function readListFromKv<TItem>(
  env: Env,
  resource: CachedListResource<TItem>
): Promise<TItem[]> {
  try {
    const cached = await createKvCacheStore(env.SLACK_KV).get(resource.kvKey, "json");
    return resource.fromCache(cached);
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: resource.kvKeyPrefix,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return [];
  }
}

/**
 * Workspace-wide Slack routing rules (keyword → repository). **Fails open** to
 * an empty list so a settings-fetch problem never blocks classification — the
 * bot behaves as if no rules were configured. Rules are normalized on both the
 * fresh and KV-fallback paths so callers see one canonical shape.
 */
const routingRulesResource: CachedListResource<SlackRoutingRule> = {
  path: "/integration-settings/slack",
  kvKey: ROUTING_RULES_CACHE_KEY,
  logEvent: "control_plane.fetch_routing_rules",
  kvKeyPrefix: "routing_rules_cache",
  slot: makeCacheSlot<SlackRoutingRule[]>(),
  fromResponse: (json) =>
    normalizeRoutingRules(
      (json as { settings?: SlackGlobalConfig | null }).settings?.defaults?.routingRules
    ),
  fromCache: (cached) =>
    Array.isArray(cached) ? normalizeRoutingRules(cached as SlackRoutingRule[]) : [],
};

/**
 * Channel IDs watched by enabled `slack_event` automations. **Fails closed** to
 * an empty set: an unknown watch-list means the bot forwards no channel
 * messages, so an outage pauses triggers rather than forwarding every message.
 * The last-known-good KV copy bridges short outages.
 */
const watchedChannelsResource: CachedListResource<string> = {
  path: "/integration-settings/slack/watched-channels",
  kvKey: WATCHED_CHANNELS_CACHE_KEY,
  logEvent: "control_plane.fetch_watched_channels",
  kvKeyPrefix: "watched_channels_cache",
  slot: makeCacheSlot<string[]>(),
  fromResponse: (json) => {
    const channels = (json as { channels?: string[] }).channels;
    return Array.isArray(channels) ? channels : [];
  },
  fromCache: (cached) => (Array.isArray(cached) ? (cached as string[]) : []),
};

export async function getRoutingRules(env: Env, traceId?: string): Promise<SlackRoutingRule[]> {
  return fetchCachedList(env, traceId, routingRulesResource);
}

export async function getWatchedChannels(env: Env, traceId?: string): Promise<Set<string>> {
  return new Set(await fetchCachedList(env, traceId, watchedChannelsResource));
}

/**
 * Filter repos by a free-text query against their full name (case-insensitive).
 * Returns all repos when the query is empty — the canonical filter shared by the
 * clarification picker and the App Home branch picker.
 */
export function filterReposByQuery(repos: RepoConfig[], query: string | undefined): RepoConfig[] {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return repos;
  }
  return repos.filter((repo) => repo.fullName.toLowerCase().includes(normalizedQuery));
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
 * Clear local caches (for testing or forced refresh).
 */
export function clearLocalCache(): void {
  localCache = null;
  routingRulesResource.slot.clear();
  watchedChannelsResource.slot.clear();
}
