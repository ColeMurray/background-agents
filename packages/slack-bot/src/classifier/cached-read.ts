/**
 * Shared read pipeline for control-plane resources the bot treats as
 * best-effort: in-memory cache → control plane → KV last-known-good copy,
 * **failing open** to an empty value so a fetch problem never blocks message
 * handling.
 *
 * Routing rules and environments are declarations over this. Repos keep their
 * own pipeline (they fail open to FALLBACK_REPOS with error-level alerting —
 * the bot is unusable without them), as do watched channels (fail-closed,
 * KV-first, no memory tier).
 */

import { createKvCacheStore } from "@open-inspect/shared";
import type { Env } from "../types";
import { controlPlaneFetch, KV_CACHE_TTL_SECONDS, LOCAL_CACHE_TTL_MS } from "./control-plane";
import { createLogger } from "../logger";

export interface CachedControlPlaneReadConfig<T> {
  /** Logger component name, e.g. "repos" — keeps each resource's log identity. */
  loggerName: string;
  /** Control-plane GET path, e.g. "/environments". */
  path: string;
  /** KV key for the last-known-good copy. */
  kvCacheKey: string;
  /** Event name for fetch-failure warns, e.g. "control_plane.fetch_environments". */
  fetchLogEvent: string;
  /** `key_prefix` used in KV get/put warn logs. */
  kvLogKeyPrefix: string;
  /** Parse + normalize the control-plane response body. */
  parseResponse: (body: unknown) => T;
  /** Parse + normalize a KV cache hit; return null to treat it as a miss. */
  parseCached: (cached: unknown) => T | null;
  /** Fail-open value when neither source yields data. */
  empty: T;
}

export interface CachedControlPlaneRead<T> {
  read(env: Env, traceId?: string): Promise<T>;
  /** Clear the in-memory tier (for testing or forced refresh). */
  clearLocalCache(): void;
}

export function createCachedControlPlaneRead<T>(
  config: CachedControlPlaneReadConfig<T>
): CachedControlPlaneRead<T> {
  const log = createLogger(config.loggerName);
  let localCache: { value: T; timestamp: number } | null = null;

  async function readFromKvCache(env: Env): Promise<T> {
    try {
      const cached = await createKvCacheStore(env.SLACK_KV).get(config.kvCacheKey, "json");
      const parsed = cached === null ? null : config.parseCached(cached);
      if (parsed !== null) return parsed;
    } catch (e) {
      log.warn("kv.get", {
        key_prefix: config.kvLogKeyPrefix,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
    return config.empty;
  }

  async function read(env: Env, traceId?: string): Promise<T> {
    if (localCache && Date.now() - localCache.timestamp < LOCAL_CACHE_TTL_MS) {
      return localCache.value;
    }

    const startTime = Date.now();
    try {
      const response = await controlPlaneFetch(env, config.path, traceId);

      if (!response.ok) {
        log.warn(config.fetchLogEvent, {
          trace_id: traceId,
          outcome: "error",
          http_status: response.status,
          duration_ms: Date.now() - startTime,
        });
        return readFromKvCache(env);
      }

      const value = config.parseResponse(await response.json());

      localCache = { value, timestamp: Date.now() };

      try {
        await createKvCacheStore(env.SLACK_KV).put(config.kvCacheKey, JSON.stringify(value), {
          expirationTtl: KV_CACHE_TTL_SECONDS,
        });
      } catch (e) {
        log.warn("kv.put", {
          trace_id: traceId,
          key_prefix: config.kvLogKeyPrefix,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }

      return value;
    } catch (e) {
      log.warn(config.fetchLogEvent, {
        trace_id: traceId,
        outcome: "error",
        error: e instanceof Error ? e : new Error(String(e)),
        duration_ms: Date.now() - startTime,
      });
      return readFromKvCache(env);
    }
  }

  return {
    read,
    clearLocalCache() {
      localCache = null;
    },
  };
}
