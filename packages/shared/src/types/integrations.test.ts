import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  MAX_BUILD_TIMEOUT_SECONDS,
  MAX_SLACK_ROUTING_RULES,
  matchRoutingRules,
  normalizeRoutingRules,
  resolveBuildTimeoutSeconds,
  type SlackRoutingRule,
} from "./integrations";

describe("resolveBuildTimeoutSeconds", () => {
  it("defaults when no setting is present", () => {
    expect(resolveBuildTimeoutSeconds(undefined)).toBe(DEFAULT_BUILD_TIMEOUT_SECONDS);
    expect(resolveBuildTimeoutSeconds({})).toBe(DEFAULT_BUILD_TIMEOUT_SECONDS);
  });

  it("passes through values at or below the maximum, including short ones", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 2400 })).toBe(2400);
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 60 })).toBe(60);
  });

  it("caps above the maximum", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 99999 })).toBe(
      MAX_BUILD_TIMEOUT_SECONDS
    );
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: MAX_BUILD_TIMEOUT_SECONDS })).toBe(
      MAX_BUILD_TIMEOUT_SECONDS
    );
  });

  it("falls back to the default for non-finite values", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: NaN })).toBe(
      DEFAULT_BUILD_TIMEOUT_SECONDS
    );
  });

  it("rounds fractional values before capping", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 2400.4 })).toBe(2400);
  });

  it("keeps the default below the maximum", () => {
    expect(DEFAULT_BUILD_TIMEOUT_SECONDS).toBeLessThan(MAX_BUILD_TIMEOUT_SECONDS);
  });
});

describe("normalizeRoutingRules", () => {
  it("returns an empty array for undefined or empty input", () => {
    expect(normalizeRoutingRules(undefined)).toEqual([]);
    expect(normalizeRoutingRules([])).toEqual([]);
  });

  it("trims and lowercases keyword and target", () => {
    expect(normalizeRoutingRules([{ keyword: "  FrontEnd ", target: "Acme/Web-App " }])).toEqual([
      { keyword: "frontend", target: "acme/web-app" },
    ]);
  });

  it("drops rules whose keyword or target is empty after trimming", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "   ", target: "acme/web" },
        { keyword: "frontend", target: "  " },
        { keyword: "api", target: "acme/api" },
      ])
    ).toEqual([{ keyword: "api", target: "acme/api" }]);
  });

  it("de-dupes identical (keyword, target) pairs case-insensitively", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "Frontend", target: "Acme/Web" },
      ])
    ).toEqual([{ keyword: "frontend", target: "acme/web" }]);
  });

  it("keeps the same keyword pointing at different targets (a conflict, surfaced later)", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "frontend", target: "acme/admin" },
      ])
    ).toEqual([
      { keyword: "frontend", target: "acme/web" },
      { keyword: "frontend", target: "acme/admin" },
    ]);
  });

  it("preserves environment rules with targetType, trimming but not lowercasing the id", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "  FullStack ", target: " env_ABC123 ", targetType: "environment" },
      ])
    ).toEqual([{ keyword: "fullstack", target: "env_ABC123", targetType: "environment" }]);
  });

  it("normalizes repository rules to the bare shape even when targetType is set explicitly", () => {
    expect(
      normalizeRoutingRules([{ keyword: "api", target: "Acme/API", targetType: "repository" }])
    ).toEqual([{ keyword: "api", target: "acme/api" }]);
  });

  it("keeps the same keyword pointing at a repository and an environment as distinct rules", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "frontend", target: "env_abc123", targetType: "environment" },
      ])
    ).toEqual([
      { keyword: "frontend", target: "acme/web" },
      { keyword: "frontend", target: "env_abc123", targetType: "environment" },
    ]);
  });

  it("de-dupes identical environment rules", () => {
    expect(
      normalizeRoutingRules([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
        { keyword: "FullStack", target: "env_abc123", targetType: "environment" },
      ])
    ).toEqual([{ keyword: "fullstack", target: "env_abc123", targetType: "environment" }]);
  });

  it("caps the number of rules at MAX_SLACK_ROUTING_RULES", () => {
    const many: SlackRoutingRule[] = Array.from(
      { length: MAX_SLACK_ROUTING_RULES + 25 },
      (_, i) => ({
        keyword: `kw${i}`,
        target: `acme/repo${i}`,
      })
    );
    expect(normalizeRoutingRules(many)).toHaveLength(MAX_SLACK_ROUTING_RULES);
  });
});

describe("matchRoutingRules", () => {
  const rules: SlackRoutingRule[] = [
    { keyword: "frontend", target: "acme/web" },
    { keyword: "api", target: "acme/api" },
    { keyword: "user service", target: "acme/users" },
    { keyword: "node.js", target: "acme/runtime" },
  ];

  it("returns an empty array when there are no rules", () => {
    expect(matchRoutingRules("fix the frontend", [])).toEqual([]);
  });

  it("matches a whole-word keyword present in the message, case-insensitively", () => {
    expect(matchRoutingRules("Fix the FRONTEND nav bug", rules)).toEqual([
      { keyword: "frontend", target: "acme/web" },
    ]);
  });

  it("does not match a keyword that only appears as a substring of another word", () => {
    // "api" must not match inside "rapidly"
    expect(matchRoutingRules("ship this rapidly please", rules)).toEqual([]);
  });

  it("matches a keyword at the very start and very end of the message", () => {
    expect(matchRoutingRules("frontend", rules)).toEqual([
      { keyword: "frontend", target: "acme/web" },
    ]);
    expect(matchRoutingRules("please fix the api", rules)).toEqual([
      { keyword: "api", target: "acme/api" },
    ]);
  });

  it("matches a multi-word phrase keyword", () => {
    expect(matchRoutingRules("the user service is down", rules)).toEqual([
      { keyword: "user service", target: "acme/users" },
    ]);
  });

  it("treats regex-special characters in the keyword literally", () => {
    expect(matchRoutingRules("upgrade node.js today", rules)).toEqual([
      { keyword: "node.js", target: "acme/runtime" },
    ]);
    // The "." must be literal, so it should not match an arbitrary character.
    expect(matchRoutingRules("upgrade nodexjs today", rules)).toEqual([]);
  });

  it("returns every matching rule, preserving rule order", () => {
    expect(matchRoutingRules("the api and the frontend both broke", rules)).toEqual([
      { keyword: "frontend", target: "acme/web" },
      { keyword: "api", target: "acme/api" },
    ]);
  });

  it("returns an empty array when no keyword is present", () => {
    expect(matchRoutingRules("just a normal message", rules)).toEqual([]);
  });
});
