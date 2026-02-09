/**
 * Redis cache layer.
 *
 * Replaces Cloudflare KV for caching. Provides simple get/set/delete
 * with TTL support for the repos list cache and other short-lived data.
 */

import Redis from "ioredis";
import { createLogger } from "../logger";

const log = createLogger("redis-cache");

let _redis: Redis | null = null;

/**
 * Get or create the Redis client.
 */
export function getRedis(redisUrl: string): Redis {
  if (!_redis) {
    _redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delayMs = Math.min(times * 200, 3000);
        return delayMs;
      },
      lazyConnect: true,
    });

    _redis.on("error", (err) => {
      log.error("Redis connection error", { error: err });
    });

    _redis.on("connect", () => {
      log.info("Redis connected");
    });

    // Initiate connection
    _redis.connect().catch((err) => {
      log.error("Failed to connect to Redis", { error: err });
    });
  }
  return _redis;
}

/**
 * Close the Redis client (for graceful shutdown).
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

/**
 * Cache store backed by Redis.
 *
 * Replaces Cloudflare KV namespace with a similar API.
 */
export class RedisCache {
  constructor(private readonly redis: Redis) {}

  /**
   * Get a cached value by key.
   *
   * @param key - Cache key
   * @returns Parsed JSON value or null if not found
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (err) {
      log.warn("Cache get failed", { key, error: err instanceof Error ? err : String(err) });
      return null;
    }
  }

  /**
   * Set a cached value with optional TTL.
   *
   * @param key - Cache key
   * @param value - Value to cache (will be JSON-serialized)
   * @param ttlSeconds - TTL in seconds (0 = no expiry)
   */
  async set(key: string, value: unknown, ttlSeconds: number = 0): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.redis.set(key, serialized, "EX", ttlSeconds);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch (err) {
      log.warn("Cache set failed", { key, error: err instanceof Error ? err : String(err) });
    }
  }

  /**
   * Delete a cached value.
   *
   * @param key - Cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      log.warn("Cache delete failed", { key, error: err instanceof Error ? err : String(err) });
    }
  }
}
