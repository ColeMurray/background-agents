import { describe, expect, it } from "vitest";
import { computeHmacHex } from "./crypto";

describe("computeHmacHex", () => {
  it("produces known HMAC-SHA256 hex for hello/secret", async () => {
    const result = await computeHmacHex("hello", "secret");
    expect(result).toBe("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
  });

  it("is deterministic (same inputs → same output)", async () => {
    const a = await computeHmacHex("data", "key");
    const b = await computeHmacHex("data", "key");
    expect(a).toBe(b);
  });

  it("different data → different output", async () => {
    const a = await computeHmacHex("data-a", "key");
    const b = await computeHmacHex("data-b", "key");
    expect(a).not.toBe(b);
  });

  it("different secret → different output", async () => {
    const a = await computeHmacHex("data", "key-1");
    const b = await computeHmacHex("data", "key-2");
    expect(a).not.toBe(b);
  });

  it("output is 64 lowercase hex characters", async () => {
    const result = await computeHmacHex("anything", "any-secret");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
