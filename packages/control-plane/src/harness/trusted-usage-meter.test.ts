import { describe, expect, it, vi } from "vitest";
import { TrustedUsageMeter } from "./trusted-usage-meter";

describe("TrustedUsageMeter", () => {
  it("prices measured usage only through the server-held price table", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, structuredClone(value));
      },
    };
    const costOf = vi.fn(() => 2.5);
    const meter = new TrustedUsageMeter(storage, {
      priceFor: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      costOf,
    });
    const usage = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, total: 13 };

    await meter.record("openai/gpt-5.6-sol", usage);

    expect(costOf).toHaveBeenCalledWith("openai/gpt-5.6-sol", usage);
    await expect(meter.snapshot()).resolves.toEqual({ usage, costUsd: 2.5 });
  });

  it("restores the durable meter before adding the next provider call", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, structuredClone(value));
      },
    };
    const prices = {
      priceFor: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      costOf: () => 0.25,
    };
    await new TrustedUsageMeter(storage, prices).record("openai/gpt-5.6-sol", {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    });

    const restored = new TrustedUsageMeter(storage, prices);
    await restored.record("openai/gpt-5.6-sol", {
      input: 2,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    });

    await expect(restored.snapshot()).resolves.toEqual({
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, total: 4 },
      costUsd: 0.5,
    });
  });
});
