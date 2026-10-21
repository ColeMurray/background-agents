import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { hasTrustedPrice } from "../harness/pricing";
import { createPiPriceTable } from "./price-table";

describe("the Pi harness price table", () => {
  it("prices trusted usage from the pinned Codex model catalog", () => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());
    const table = createPiPriceTable(models);

    expect(hasTrustedPrice(table, "openai/gpt-5.6-sol")).toBe(true);
    expect(
      table.costOf("openai/gpt-5.6-sol", {
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
    const table = createPiPriceTable(models);

    expect(hasTrustedPrice(table, "openai/not-priced")).toBe(false);
    expect(() =>
      table.costOf("openai/not-priced", {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
      })
    ).toThrow("trusted server pricing");
  });
});
