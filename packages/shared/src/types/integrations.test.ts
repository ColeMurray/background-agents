import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  INTERNAL_TTYD_PORT,
  INTERNAL_VNC_PORT,
  MAX_BUILD_TIMEOUT_SECONDS,
  MAX_SLACK_ROUTING_RULES,
  isValidSandboxTimeoutMs,
  findSandboxPortConflict,
  matchRoutingRules,
  mcpServerCommandSchema,
  mcpServerCredentialMapSchema,
  mcpServerTypeSchema,
  normalizeRoutingRules,
  resolveBuildTimeoutSeconds,
  scmGlobalConfigSchema,
  scmSettingsSchema,
  integrationSettingsSchemas,
  slackIntegrationSettingsRoutingResponseSchema,
  type SlackRoutingRule,
} from "./integrations";

describe("findSandboxPortConflict", () => {
  it.each([INTERNAL_TTYD_PORT, INTERNAL_VNC_PORT])("rejects reserved internal port %i", (port) => {
    expect(findSandboxPortConflict([{ port, label: "tunnel port" }])).toEqual({
      kind: "reserved",
      port,
      label: "tunnel port",
    });
  });
});

describe("isValidSandboxTimeoutMs", () => {
  it("accepts safe positive whole-second millisecond values", () => {
    expect(isValidSandboxTimeoutMs(1_000)).toBe(true);
    expect(isValidSandboxTimeoutMs(14_400_000)).toBe(true);
  });

  it.each([undefined, "1000", 0, -1_000, 1_500, 1_000.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid timeout %s",
    (value) => {
      expect(isValidSandboxTimeoutMs(value)).toBe(false);
    }
  );
});

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

describe("SCM settings schemas", () => {
  it("parses and normalizes valid global and repo settings", () => {
    expect(
      scmGlobalConfigSchema.parse({
        defaults: { alwaysUseDraftMode: true, pullRequestLabel: "  agent  " },
      })
    ).toEqual({ defaults: { alwaysUseDraftMode: true, pullRequestLabel: "agent" } });
    expect(scmSettingsSchema.parse({ alwaysUseDraftMode: false, pullRequestLabel: "   " })).toEqual(
      { alwaysUseDraftMode: false }
    );
  });

  it("rejects malformed global and repo settings", () => {
    expect(scmGlobalConfigSchema.safeParse({ enabledRepos: ["acme/web"] }).success).toBe(false);
    expect(scmGlobalConfigSchema.safeParse({ defaults: { pullRequestLabel: 123 } }).success).toBe(
      false
    );
    expect(scmSettingsSchema.safeParse({ alwaysUseDraftMode: "yes" }).success).toBe(false);
    expect(scmSettingsSchema.safeParse({ pullRequestLabel: "release,agent" }).success).toBe(false);
  });
});

describe("MCP server schemas", () => {
  it("accepts canonical persisted MCP fields", () => {
    expect(mcpServerTypeSchema.parse("local")).toBe("local");
    expect(mcpServerCommandSchema.parse(["npx", "-y", "@playwright/mcp"])).toEqual([
      "npx",
      "-y",
      "@playwright/mcp",
    ]);
    expect(mcpServerCredentialMapSchema.parse({ DEBUG: "1" })).toEqual({ DEBUG: "1" });
  });

  it("rejects malformed MCP command and credential fields", () => {
    expect(mcpServerCommandSchema.safeParse([]).success).toBe(false);
    expect(mcpServerCommandSchema.safeParse(["npx", 1]).success).toBe(false);
    expect(mcpServerCredentialMapSchema.safeParse({ DEBUG: 1 }).success).toBe(false);
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

describe("slackIntegrationSettingsRoutingResponseSchema", () => {
  it("parses a valid routing settings response", () => {
    const parsed = slackIntegrationSettingsRoutingResponseSchema.safeParse({
      settings: {
        defaults: {
          routingRules: [{ keyword: "frontend", target: "acme/web" }],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("parses a null settings response", () => {
    expect(
      slackIntegrationSettingsRoutingResponseSchema.safeParse({ settings: null }).success
    ).toBe(true);
  });

  it("rejects malformed routing rules", () => {
    expect(
      slackIntegrationSettingsRoutingResponseSchema.safeParse({
        settings: { defaults: { routingRules: [{ keyword: "frontend" }] } },
      }).success
    ).toBe(false);
  });
});

describe("integration settings schemas", () => {
  it("parses valid global and repo settings", () => {
    expect(
      integrationSettingsSchemas.github.global.safeParse({
        enabledRepos: null,
        defaults: { autoReviewOnOpen: false, allowedTriggerUsers: ["alice"] },
      }).success
    ).toBe(true);
    expect(
      integrationSettingsSchemas.slack.repo.safeParse({ agentNotificationsEnabled: true }).success
    ).toBe(true);
  });

  it("rejects malformed stored settings", () => {
    expect(
      integrationSettingsSchemas.github.global.safeParse({
        enabledRepos: [42],
        defaults: { autoReviewOnOpen: false },
      }).success
    ).toBe(false);
    expect(
      integrationSettingsSchemas.slack.repo.safeParse({ agentNotificationsEnabled: "yes" }).success
    ).toBe(false);
  });

  it("rejects unknown keys without stripping them", () => {
    expect(
      integrationSettingsSchemas.github.global.safeParse({
        defaults: { autoReviewOnOpen: false, autoReviewOnOpened: true },
      }).success
    ).toBe(false);
    expect(
      integrationSettingsSchemas.github.repo.safeParse({
        autofix: { enabled: true, unknownPolicy: true },
      }).success
    ).toBe(false);
    expect(
      integrationSettingsSchemas.scm.global.safeParse({ enabledRepos: ["acme/widgets"] }).success
    ).toBe(false);
  });

  it("parses nullable sandbox resource settings", () => {
    expect(
      integrationSettingsSchemas.sandbox.repo.safeParse({ cpuCores: null, memoryMib: null }).success
    ).toBe(true);
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
