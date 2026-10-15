import { describe, expect, it, vi } from "vitest";
import { CACHE_STORE_MIN_TTL_MS, createKvCacheStore } from "./cache-store";

function fakeKv() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("createKvCacheStore TTL mapping (#1779)", () => {
  it("sends whole seconds for an exact-second TTL", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v", { ttlMs: 300_000 });
    expect(kv.put).toHaveBeenCalledWith("k", "v", { expirationTtl: 300 });
  });

  it("rounds a sub-second remainder up, never down", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v", { ttlMs: 300_001 });
    expect(kv.put).toHaveBeenCalledWith("k", "v", { expirationTtl: 301 });
  });

  it("sends the minimum TTL as KV's shortest expiration", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    expect(kv.put).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
  });

  it.each([CACHE_STORE_MIN_TTL_MS - 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a ttlMs of %s without writing to KV",
    async (ttlMs) => {
      const kv = fakeKv();
      await expect(createKvCacheStore(kv).put("k", "v", { ttlMs })).rejects.toThrow(RangeError);
      expect(kv.put).not.toHaveBeenCalled();
    }
  );

  it("sends no TTL option when none is asked for", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v");
    expect(kv.put).toHaveBeenCalledWith("k", "v");
  });
});
