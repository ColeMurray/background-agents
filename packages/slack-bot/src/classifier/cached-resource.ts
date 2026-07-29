/**
 * Read-through cache with tiered fallback for the bot's best-effort
 * control-plane reads: in-memory (TTL) → loader → KV last-known-good copy →
 * fallback value. **Fails open** — a load problem never blocks message
 * handling; callers get the last-known-good copy, or the fallback.
 *
 * Routing rules and environments are declarations over this. Repos keep their
 * own pipeline (they fail open to FALLBACK_REPOS with error-level alerting —
 * the bot is unusable without them), as do watched channels (fail-closed,
 * KV-first, no memory tier).
 */

import {
  createKvCacheStore,
  createReadThroughCache,
  type ReadThroughCache,
} from "@open-inspect/shared";
import type { Env } from "../types";
import {
  ControlPlaneRequestError,
  KV_CACHE_TTL_SECONDS,
  LOCAL_CACHE_TTL_MS,
} from "./control-plane";
import { createLogger } from "../logger";

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

export type CachedResource<T> = ReadThroughCache<T, Env>;

export function createCachedResource<T>(options: CachedResourceOptions<T>): CachedResource<T> {
  const log = createLogger(options.name);
  const loadFailureEvent = `control_plane.fetch_${options.name}`;
  const kvLogKeyPrefix = `${options.name}_cache`;

  return createReadThroughCache<T, Env>({
    cacheKey: options.kvKey,
    cacheTtlSeconds: KV_CACHE_TTL_SECONDS,
    localTtlMs: LOCAL_CACHE_TTL_MS,
    load: options.load,
    getCacheStore: (env) => createKvCacheStore(env.SLACK_KV),
    deserialize: options.deserialize,
    fallback: options.fallback,
    onLoadError: (error, { traceId, durationMs }) => {
      log.warn(loadFailureEvent, {
        trace_id: traceId,
        outcome: "error",
        http_status: error instanceof ControlPlaneRequestError ? error.status : undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        duration_ms: durationMs,
      });
    },
    onCacheError: (operation, error, traceId) => {
      log.warn(`kv.${operation}`, {
        trace_id: traceId,
        key_prefix: kvLogKeyPrefix,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    },
  });
}
