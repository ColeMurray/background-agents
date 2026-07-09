/**
 * Environment fetching from the control plane, for team/project mappings that
 * target a saved environment. Same pattern as classifier/repos.ts: local
 * cache + KV cache + fail open to an empty list, so an environments-fetch
 * problem never blocks issue handling — mappings targeting an environment are
 * simply skipped and resolution falls through to the next stage.
 */

import type { Env, Environment, ListEnvironmentsResponse } from "./types";
import { buildInternalAuthHeaders } from "./utils/internal";
import { createLogger } from "./logger";

const log = createLogger("environments");

const LOCAL_CACHE_TTL_MS = 60 * 1000;

let localCache: {
  environments: Environment[];
  timestamp: number;
} | null = null;

export async function getAvailableEnvironments(env: Env, traceId?: string): Promise<Environment[]> {
  if (localCache && Date.now() - localCache.timestamp < LOCAL_CACHE_TTL_MS) {
    return localCache.environments;
  }

  const startTime = Date.now();
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
    };

    const response = await env.CONTROL_PLANE.fetch("https://internal/environments", { headers });

    if (!response.ok) {
      log.error("control_plane.fetch_environments", {
        trace_id: traceId,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return getFromCacheOrFallback(env);
    }

    const data = (await response.json()) as ListEnvironmentsResponse;
    const environments = Array.isArray(data.environments) ? data.environments : [];

    localCache = { environments, timestamp: Date.now() };

    try {
      await env.LINEAR_KV.put("environments:cache", JSON.stringify(environments), {
        expirationTtl: 300,
      });
    } catch (e) {
      log.warn("kv.put", {
        trace_id: traceId,
        key_prefix: "environments_cache",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }

    log.info("control_plane.fetch_environments", {
      trace_id: traceId,
      outcome: "success",
      environment_count: environments.length,
      duration_ms: Date.now() - startTime,
    });

    return environments;
  } catch (e) {
    log.error("control_plane.fetch_environments", {
      trace_id: traceId,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return getFromCacheOrFallback(env);
  }
}

async function getFromCacheOrFallback(env: Env): Promise<Environment[]> {
  try {
    const cached = await env.LINEAR_KV.get("environments:cache", "json");
    if (cached && Array.isArray(cached)) {
      log.info("control_plane.fetch_environments", { source: "kv_cache" });
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
  const all = await getAvailableEnvironments(env, traceId);
  return all.find((environment) => environment.id === environmentId);
}

/**
 * Clear the in-memory cache (for testing).
 */
export function clearEnvironmentsLocalCache(): void {
  localCache = null;
}
