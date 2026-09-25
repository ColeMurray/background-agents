import { describe, expect, it } from "vitest";
import { sandboxEventSchema, tokenUsageSchema } from "./sandbox-events";
import { normalizeTokenUsage } from "./usage";

describe("normalizeTokenUsage", () => {
  it("treats a bare number as a total without inventing parts", () => {
    expect(normalizeTokenUsage(12)).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 12,
    });
  });

  it("keeps a reported total separate from the sum of full details", () => {
    expect(
      normalizeTokenUsage({
        total: 100,
        input: 40,
        output: 30,
        reasoning: 10,
        cache: { read: 8, write: 2 },
      })
    ).toEqual({
      inputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 10,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      totalTokens: 100,
    });
  });

  it("sums only present parts and leaves missing parts unknown", () => {
    expect(normalizeTokenUsage({ input: 4, output: 0 })).toEqual({
      inputTokens: 4,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 4,
    });
  });

  it("counts cache-only usage", () => {
    expect(normalizeTokenUsage({ cache: { read: 6, write: 3 } })).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: 6,
      cacheWriteTokens: 3,
      totalTokens: 9,
    });
  });

  it("leaves absent usage unknown", () => {
    expect(normalizeTokenUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    });
  });

  it("ignores negative and non-finite values, including a reported total", () => {
    expect(
      normalizeTokenUsage({
        total: -1,
        input: Number.NaN,
        output: 3,
        reasoning: Number.POSITIVE_INFINITY,
        cache: { read: -2, write: 0 },
      })
    ).toEqual({
      inputTokens: null,
      outputTokens: 3,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      totalTokens: 3,
    });
    expect(normalizeTokenUsage(-3).totalTokens).toBeNull();
    expect(normalizeTokenUsage(Number.NaN).totalTokens).toBeNull();
    expect(normalizeTokenUsage({ input: -1, cache: { write: Number.NaN } }).totalTokens).toBeNull();
    expect(
      normalizeTokenUsage({ input: Number.MAX_VALUE, output: Number.MAX_VALUE }).totalTokens
    ).toBeNull();
  });

  it("ignores fractional and unsafe counts and sums only safe integer parts", () => {
    expect(normalizeTokenUsage(1.5).totalTokens).toBeNull();
    expect(normalizeTokenUsage(Number.MAX_SAFE_INTEGER + 1).totalTokens).toBeNull();
    expect(normalizeTokenUsage({ total: 1.5, input: 2 }).totalTokens).toBe(2);
    expect(normalizeTokenUsage({ total: Number.MAX_SAFE_INTEGER + 1, input: 2 }).totalTokens).toBe(
      2
    );
    expect(
      normalizeTokenUsage({ input: 1.5, output: 2, cache: { read: Number.MAX_VALUE } })
    ).toEqual({
      inputTokens: null,
      outputTokens: 2,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 2,
    });
    expect(
      normalizeTokenUsage({ input: Number.MAX_SAFE_INTEGER, output: 1 }).totalTokens
    ).toBeNull();
  });

  it("rejects empty details using the existing token schema refine", () => {
    expect(tokenUsageSchema.safeParse({}).success).toBe(false);
    expect(tokenUsageSchema.safeParse({ cache: {} }).success).toBe(false);
  });
});

describe("stepId on sandbox events", () => {
  it.each(["step_start", "step_finish"] as const)("keeps an optional id on %s", (type) => {
    const event = { type, sandboxId: "sandbox-1", timestamp: 1, messageId: "message-1" };
    expect(sandboxEventSchema.parse({ ...event, stepId: "step-1" })).toMatchObject({
      stepId: "step-1",
    });
    expect(sandboxEventSchema.parse(event)).not.toHaveProperty("stepId");
    expect(sandboxEventSchema.safeParse({ ...event, stepId: "" }).success).toBe(false);
  });
});
