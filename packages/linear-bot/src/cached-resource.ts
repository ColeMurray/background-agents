/**
 * Read-through cache with tiered fallback for the bot's best-effort
 * control-plane reads: in-memory (TTL) → loader → KV last-known-good copy →
 * fallback value. **Fails open** — a load problem never blocks issue
 * handling; callers get the last-known-good copy, or the fallback.
 *
 * Repos and environments are declarations over this. Mirrors slack-bot's
 * classifier/cached-resource.ts.
 */

import { createKvCacheStore } from "@open-inspect/shared";
import type { Env } from "./types";
import {
  ControlPlaneRequestError,
  KV_CACHE_TTL_SECONDS,
  LOCAL_CACHE_TTL_MS,
} from "./control-plane";
import { createLogger } from "./logger";

export interface CachedResourceOptions<T> {
  /**
   * Snake-case resource name. Names the logger and derives the log
   * identities: load failures log `control_plane.fetch_<name>` and KV
   * warnings use `key_prefix: "<name>_cache"`.
   */
  name: string;
  /** KV key for the last-known-good copy (stores the value as JSON). */
  kvKey: string;
  /** Fetch and parse the fresh value. A throw falls back to the KV copy. */
  load: (env: Env, traceId?: string) => Promise<T>;
  /** Revive a KV hit; return null to treat it as a miss. */
  deserialize: (cached: unknown) => T | null;
  /** Served when the loader and the KV copy both fail — the fail-open value. */
  fallback: T;
}

export interface CachedResource<T> {
  get(env: Env, traceId?: string): Promise<T>;
  /**
   * Drop the in-memory copy so the next get() reloads. The KV copy is
   * deliberately kept — it is fallback data, not authority.
   */
  invalidate(): void;
}

export function createCachedResource<T>(options: CachedResourceOptions<T>): CachedResource<T> {
  const log = createLogger(options.name);
  const loadFailureEvent = `control_plane.fetch_${options.name}`;
  const kvLogKeyPrefix = `${options.name}_cache`;
  let memory: { value: T; timestamp: number } | null = null;

  async function readKvFallback(env: Env): Promise<T> {
    try {
      const cached = await createKvCacheStore(env.LINEAR_KV).get(options.kvKey, "json");
      const value = cached === null ? null : options.deserialize(cached);
      if (value !== null) return value;
    } catch (e) {
      log.warn("kv.get", {
        key_prefix: kvLogKeyPrefix,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
    return options.fallback;
  }

  async function get(env: Env, traceId?: string): Promise<T> {
    if (memory && Date.now() - memory.timestamp < LOCAL_CACHE_TTL_MS) {
      return memory.value;
    }

    const startTime = Date.now();
    try {
      const value = await options.load(env, traceId);
      memory = { value, timestamp: Date.now() };

      try {
        await createKvCacheStore(env.LINEAR_KV).put(options.kvKey, JSON.stringify(value), {
          expirationTtl: KV_CACHE_TTL_SECONDS,
        });
      } catch (e) {
        log.warn("kv.put", {
          trace_id: traceId,
          key_prefix: kvLogKeyPrefix,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }

      return value;
    } catch (e) {
      log.warn(loadFailureEvent, {
        trace_id: traceId,
        outcome: "error",
        http_status: e instanceof ControlPlaneRequestError ? e.status : undefined,
        error: e instanceof Error ? e : new Error(String(e)),
        duration_ms: Date.now() - startTime,
      });
      return readKvFallback(env);
    }
  }

  return {
    get,
    invalidate() {
      memory = null;
    },
  };
}
