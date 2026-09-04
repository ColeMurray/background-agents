import { describe, expect, it } from "vitest";
import { createMemoryCacheStore } from "./memory-cache-store";

describe("createMemoryCacheStore", () => {
  it("stores strings and parses them as json on request", async () => {
    const cache = createMemoryCacheStore();
    expect(await cache.get("missing")).toBeNull();
    await cache.put("repos", JSON.stringify({ items: [1] }));
    expect(await cache.get("repos")).toBe('{"items":[1]}');
    expect(await cache.get<{ items: number[] }>("repos", "json")).toEqual({ items: [1] });
    await cache.delete("repos");
    expect(await cache.get("repos")).toBeNull();
  });

  it("expires an entry after its ttl in seconds", async () => {
    let clock = 1_000_000;
    const cache = createMemoryCacheStore({ now: () => clock });
    await cache.put("k", "v", { expirationTtl: 60 });
    clock += 59_999;
    expect(await cache.get("k")).toBe("v");
    clock += 1;
    expect(await cache.get("k")).toBeNull();
  });

  it("drops the oldest entry past the bound, counting a refreshed key as new", async () => {
    const cache = createMemoryCacheStore({ maxEntries: 2 });
    await cache.put("a", "1");
    await cache.put("b", "2");
    await cache.put("a", "3");
    await cache.put("c", "4");
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).toBe("3");
    expect(await cache.get("c")).toBe("4");
  });
});
