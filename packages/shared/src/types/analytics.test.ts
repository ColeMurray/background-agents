import { expect, it } from "vitest";
import {
  ANALYTICS_SCOPE_SPAWN_SOURCES,
  ANALYTICS_SPAWN_SOURCE_SCOPE,
  getCacheHitRatio,
} from "./analytics";

it("derives the existing human population from the exhaustive spawn-source mapping", () => {
  expect(ANALYTICS_SPAWN_SOURCE_SCOPE).toEqual({
    user: "human",
    "slack-bot": "human",
    "linear-bot": "human",
    "github-bot": "human",
    agent: "agent",
    automation: "automation",
  });
  expect(ANALYTICS_SCOPE_SPAWN_SOURCES.human).toEqual([
    "user",
    "slack-bot",
    "linear-bot",
    "github-bot",
  ]);
  expect(ANALYTICS_SCOPE_SPAWN_SOURCES.agent).toEqual(["agent"]);
  expect(ANALYTICS_SCOPE_SPAWN_SOURCES.automation).toEqual(["automation"]);
});

it("computes cache hits against cache reads plus uncached inputs, or null for no input", () => {
  expect(getCacheHitRatio({ cacheReadTokens: 3, inputTokens: 1 })).toBe(0.75);
  expect(getCacheHitRatio({ cacheReadTokens: 0, inputTokens: 5 })).toBe(0);
  expect(getCacheHitRatio({ cacheReadTokens: 0, inputTokens: 0 })).toBeNull();
});
