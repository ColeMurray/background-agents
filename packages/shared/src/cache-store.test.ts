import { describe, expect, it, vi } from "vitest";
import { createKvCacheStore } from "./cache-store";

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

  it("raises a sub-minute TTL to the KV minimum instead of sending a value KV rejects", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v", { ttlMs: 30_000 });
    expect(kv.put).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
  });

  it("sends no TTL option when none is asked for", async () => {
    const kv = fakeKv();
    await createKvCacheStore(kv).put("k", "v");
    expect(kv.put).toHaveBeenCalledWith("k", "v");
  });
});
