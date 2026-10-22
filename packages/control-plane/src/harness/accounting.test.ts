import { describe, expect, it } from "vitest";
import type { UsageState } from "@earendil-works/pi-durable";
import { accountingDelta, summarizeUsage } from "../harness/accounting";

function usage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

describe("the harness usage diagnostics", () => {
  it("preserves counters but ignores runtime-provided prices", () => {
    const baseline = summarizeUsage({
      models: { "openai-codex/gpt": usage(10, 1, 0.4) },
      tools: {},
    } satisfies UsageState);
    const current = summarizeUsage({
      // Pi has already priced each request before accumulating this bucket.
      models: {
        "openai-codex/gpt": usage(310_000, 30, 2.1),
        "openai-codex/child": usage(25_000, 10, 0.5),
      },
      tools: { subagent: usage(5_000, 5, 0.3) },
    } satisfies UsageState);

    expect(accountingDelta(current, baseline)).toEqual({
      usage: {
        input: 339_990,
        output: 44,
        cacheRead: 0,
        cacheWrite: 0,
        total: 340_034,
      },
      costUsd: 0,
    });
  });

  it("does not trust a malformed provider cost total", () => {
    const malformed = {
      models: { "openai-codex/gpt": usage(1, 1, Number.NaN) },
      tools: {},
    } satisfies UsageState;

    expect(summarizeUsage(malformed).costUsd).toBe(0);
  });

  it("does not trust an overflowing aggregate provider cost", () => {
    const malformed = {
      models: {
        "openai-codex/gpt": usage(1, 1, Number.MAX_VALUE),
        "openai-codex/child": usage(1, 1, Number.MAX_VALUE),
      },
      tools: {},
    } satisfies UsageState;

    expect(summarizeUsage(malformed).costUsd).toBe(0);
  });
});
