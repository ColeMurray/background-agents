import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/provider-usage/openai.json";
import { parseOpenAIUsage } from "./openai-usage";

const NOW = 1_900_000_000_000;
describe("official Codex usage protocol", () => {
  it("parses the pinned official fixture without inferring admission from percent", () => {
    expect(parseOpenAIUsage(fixture, NOW)).toEqual({
      status: "available",
      collectedAt: NOW,
      expiresAt: NOW + 60_000,
      allowed: true,
      limitReached: false,
      windows: [
        { id: "primary", usedPercent: 100, windowDurationMs: 300_000, resetsAt: 2_000_000_000_000 },
      ],
    });
  });
  it("keeps both independent reset windows and expires at the next reset", () => {
    expect(
      parseOpenAIUsage(
        {
          rate_limit: {
            ...fixture.rate_limit,
            primary_window: {
              ...fixture.rate_limit.primary_window,
              used_percent: 0,
              reset_at: NOW / 1000 + 20,
            },
            secondary_window: {
              ...fixture.rate_limit.primary_window,
              used_percent: 72,
              limit_window_seconds: 604800,
            },
          },
        },
        NOW
      )
    ).toMatchObject({
      expiresAt: NOW + 20_000,
      windows: [
        { id: "primary", usedPercent: 0 },
        { id: "secondary", usedPercent: 72, windowDurationMs: 604_800_000 },
      ],
    });
  });
  it.each([{}, { rate_limit: null }])(
    "does not treat missing limits as zero usage: %j",
    (payload) => {
      expect(parseOpenAIUsage(payload, NOW)).toEqual({ status: "unavailable", reason: "no_data" });
    }
  );
  it("accepts missing windows and strips unrelated provider fields", () => {
    expect(
      parseOpenAIUsage(
        {
          secret: "never-forward",
          rate_limit: { allowed: false, limit_reached: true, primary_window: null },
        },
        NOW
      )
    ).toEqual({
      status: "available",
      collectedAt: NOW,
      expiresAt: NOW + 60_000,
      allowed: false,
      limitReached: true,
      windows: [],
    });
  });
  it.each([-1, 101, 0.5, "25", null])("rejects invalid percentages %j", (used_percent) => {
    expect(
      parseOpenAIUsage(
        {
          rate_limit: {
            ...fixture.rate_limit,
            primary_window: { ...fixture.rate_limit.primary_window, used_percent },
          },
        },
        NOW
      )
    ).toEqual({ status: "unavailable", reason: "invalid_response" });
  });
  it("does not replace past reset timestamps with invented remaining quota", () => {
    expect(
      parseOpenAIUsage(
        {
          rate_limit: {
            ...fixture.rate_limit,
            primary_window: { ...fixture.rate_limit.primary_window, reset_at: NOW / 1000 - 1 },
          },
        },
        NOW
      )
    ).toMatchObject({ windows: [{ usedPercent: 100, resetsAt: NOW - 1000 }] });
  });
});
