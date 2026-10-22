import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { calculateUsageCost, hasTrustedPricing } from "./pricing";

describe("Pi server-side pricing", () => {
  it("prices trusted usage from the pinned Codex model catalog", () => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());

    expect(hasTrustedPricing(models, "openai/gpt-5.6-sol")).toBe(true);
    expect(
      calculateUsageCost(models, "openai/gpt-5.6-sol", {
        input: 1_000,
        output: 1_000,
        cacheRead: 1_000,
        cacheWrite: 1_000,
        total: 4_000,
      })
    ).toBeCloseTo(0.0294, 10);
  });

  it("fails closed for a model absent from the trusted catalog", () => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());

    expect(hasTrustedPricing(models, "openai/not-priced")).toBe(false);
    expect(() =>
      calculateUsageCost(models, "openai/not-priced", {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
      })
    ).toThrow("trusted server pricing");
  });

  it("applies tier pricing independently to each model request", () => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());
    const call = {
      input: 150_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 150_000,
    };

    expect(
      calculateUsageCost(models, "openai/gpt-5.6-sol", call) +
        calculateUsageCost(models, "openai/gpt-5.6-sol", call)
    ).toBeCloseTo(1.2, 10);
    expect(
      calculateUsageCost(models, "openai/gpt-5.6-sol", {
        ...call,
        input: 300_000,
        total: 300_000,
      })
    ).toBeCloseTo(2.4, 10);
  });
});
