/**
 * The `CacheStore` contract, run against every implementation of the port:
 * Cloudflare KV in the workerd lane (test/integration/cache-store-conformance.test.ts)
 * and `SqlCacheStore` in both lanes, over D1 there and `node:sqlite` here
 * (cache-store-conformance.node.test.ts). Callers treat the two as
 * interchangeable, so each case pins a semantic one of them could otherwise
 * drift on.
 *
 * Expiry is the one case KV cannot run: its clock is the runtime's, and it
 * rejects a TTL under a minute, so an honest test would sleep for one. The
 * suite runs it against the implementations whose clock the caller owns and
 * asserts on KV only that an entry with a TTL is readable before it passes —
 * which is what the port promises and all a caller can observe either way.
 */

import { describe, expect, it } from "vitest";
import type { CacheStore } from "@open-inspect/shared/cache-store";

/** The shortest TTL Cloudflare KV accepts; the suite writes no shorter one. */
const MIN_TTL_SECONDS = 60;

export interface CacheStoreUnderTest {
  store: CacheStore;
  /**
   * Move the store's clock forward by `ms`. Present only where the caller
   * owns the clock; KV reads the runtime's.
   */
  advance?: (ms: number) => void;
}

/** Runs one assertion against an implementation; the callback owns its lifetime. */
export type CacheStoreFactory = <T>(
  run: (subject: CacheStoreUnderTest) => Promise<T>
) => Promise<T>;

export interface CacheStoreCapabilities {
  /**
   * Whether the caller can move the store's clock. Declared rather than
   * inferred so the expiry case reports as skipped on KV instead of passing
   * on an implementation that never ran it.
   */
  controllableClock: boolean;
}

export function registerCacheStoreConformanceSuite(
  factory: CacheStoreFactory,
  capabilities: CacheStoreCapabilities
): void {
  /**
   * Runs `run` against a key no other case uses, and removes it afterwards:
   * a KV namespace outlives the test that wrote to it.
   */
  const withKey = <T>(
    name: string,
    run: (subject: CacheStoreUnderTest, key: string) => Promise<T>
  ): Promise<T> =>
    factory(async (subject) => {
      const key = `conformance:${name}:${crypto.randomUUID()}`;
      try {
        return await run(subject, key);
      } finally {
        await subject.store.delete(key);
      }
    });

  describe("CacheStore conformance", () => {
    it("reads null for a key that was never written, in both get forms", async () => {
      await withKey("miss", async ({ store }, key) => {
        expect(await store.get(key)).toBeNull();
        expect(await store.get(key, "json")).toBeNull();
      });
    });

    it("reads back the string it was given", async () => {
      await withKey("round-trip", async ({ store }, key) => {
        await store.put(key, "a value");
        expect(await store.get(key)).toBe("a value");
      });
    });

    it("parses the stored text on a json read", async () => {
      await withKey("json", async ({ store }, key) => {
        const value = { repos: [{ name: "one" }], cachedAt: "2026-01-01T00:00:00.000Z" };
        await store.put(key, JSON.stringify(value));
        expect(await store.get(key, "json")).toEqual(value);
      });
    });

    it("replaces the value and the TTL of a key written twice", async () => {
      await withKey("overwrite", async ({ store, advance }, key) => {
        await store.put(key, "first", { expirationTtl: MIN_TTL_SECONDS });
        await store.put(key, "second");
        expect(await store.get(key)).toBe("second");
        // The second write cleared the first's expiry rather than inheriting
        // it. Only an implementation whose clock we own can be carried past
        // that expiry to prove it; on KV the assertion above is the whole case.
        advance?.(MIN_TTL_SECONDS * 1000 + 1);
        expect(await store.get(key)).toBe("second");
      });
    });

    it("deletes a key, and deleting an absent key is not an error", async () => {
      await withKey("delete", async ({ store }, key) => {
        await store.put(key, "a value");
        await store.delete(key);
        expect(await store.get(key)).toBeNull();
        await store.delete(key);
      });
    });

    it("serves an entry that still has time left on its TTL", async () => {
      await withKey("ttl-live", async ({ store }, key) => {
        await store.put(key, "a value", { expirationTtl: MIN_TTL_SECONDS });
        expect(await store.get(key)).toBe("a value");
      });
    });

    it.skipIf(!capabilities.controllableClock)("reads null once the TTL has passed", async () => {
      await withKey("ttl-expired", async ({ store, advance }, key) => {
        if (!advance) throw new Error("A controllable clock was declared but none was supplied");
        await store.put(key, "a value", { expirationTtl: MIN_TTL_SECONDS });
        advance(MIN_TTL_SECONDS * 1000 + 1);
        expect(await store.get(key)).toBeNull();
        expect(await store.get(key, "json")).toBeNull();
      });
    });

    it("keeps an entry written without a TTL past when a TTL would have expired", async () => {
      await withKey("no-ttl", async ({ store, advance }, key) => {
        await store.put(key, "a value");
        advance?.(MIN_TTL_SECONDS * 1000 + 1);
        expect(await store.get(key)).toBe("a value");
      });
    });
  });
}
