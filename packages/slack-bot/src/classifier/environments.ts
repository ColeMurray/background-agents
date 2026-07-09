/**
 * Environment fetching from the control plane, for routing rules that target a
 * saved environment.
 *
 * Mirrors the repos module: in-memory cache → control plane GET /environments →
 * KV cache, and **fails open to an empty list** so an environments-fetch
 * problem never blocks classification — rules targeting an environment are
 * simply skipped, like rules targeting an inaccessible repository.
 */

import type { Environment, ListEnvironmentsResponse } from "@open-inspect/shared";
import { createKvCacheStore } from "@open-inspect/shared";
import type { Env } from "../types";
import { controlPlaneFetch, KV_CACHE_TTL_SECONDS, LOCAL_CACHE_TTL_MS } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("environments");

const ENVIRONMENTS_CACHE_KEY = "slack:environments";

let environmentsLocalCache: {
  environments: Environment[];
  timestamp: number;
} | null = null;

/**
 * Fetch the workspace's environments from the control plane.
 */
export async function getAvailableEnvironments(env: Env, traceId?: string): Promise<Environment[]> {
  if (
    environmentsLocalCache &&
    Date.now() - environmentsLocalCache.timestamp < LOCAL_CACHE_TTL_MS
  ) {
    return environmentsLocalCache.environments;
  }

  const startTime = Date.now();
  try {
    const response = await controlPlaneFetch(env, "/environments", traceId);

    if (!response.ok) {
      log.warn("control_plane.fetch_environments", {
        trace_id: traceId,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return getEnvironmentsFromCache(env);
    }

    const data = (await response.json()) as ListEnvironmentsResponse;
    const environments = Array.isArray(data.environments) ? data.environments : [];

    environmentsLocalCache = { environments, timestamp: Date.now() };

    try {
      await createKvCacheStore(env.SLACK_KV).put(
        ENVIRONMENTS_CACHE_KEY,
        JSON.stringify(environments),
        { expirationTtl: KV_CACHE_TTL_SECONDS }
      );
    } catch (e) {
      log.warn("kv.put", {
        trace_id: traceId,
        key_prefix: "environments_cache",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    return environments;
  } catch (e) {
    log.warn("control_plane.fetch_environments", {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return getEnvironmentsFromCache(env);
  }
}

/**
 * Read environments from the KV cache, returning an empty list on miss/error.
 * Fail open: no environments means environment-targeted rules are skipped, the
 * safe default.
 */
async function getEnvironmentsFromCache(env: Env): Promise<Environment[]> {
  try {
    const cached = await createKvCacheStore(env.SLACK_KV).get(ENVIRONMENTS_CACHE_KEY, "json");
    if (cached && Array.isArray(cached)) {
      return cached as Environment[];
    }
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: "environments_cache",
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
  return [];
}

/**
 * Find an environment by its stable id.
 */
export async function getEnvironmentById(
  env: Env,
  environmentId: string,
  traceId?: string
): Promise<Environment | undefined> {
  const environments = await getAvailableEnvironments(env, traceId);
  return environments.find((environment) => environment.id === environmentId);
}

/**
 * Clear the local cache (for testing or forced refresh).
 */
export function clearEnvironmentsLocalCache(): void {
  environmentsLocalCache = null;
}
