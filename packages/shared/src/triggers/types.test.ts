import { describe, expect, it } from "vitest";
import { automationEventSchema, githubAutomationEventSchema, triggerConfigSchema } from "./types";
import { buildMockEvent } from "./testing";

describe("automationEventSchema", () => {
  it("parses a valid Slack automation event", () => {
    const result = automationEventSchema.safeParse({
      source: "slack",
      eventType: "message.posted",
      triggerKey: "slack:msg:C1:1700000000.000200",
      concurrencyKey: "slack:C1:1700000000.000100",
      contextBlock: "A message was posted in #ops.",
      meta: {},
      channelId: "C1",
      permalink: "https://example.slack.com/archives/C1/p1700000000000200",
      threadTs: "1700000000.000100",
      ts: "1700000000.000200",
      actorUserId: "U1",
      text: "please deploy the api",
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.source === "slack") {
      expect(result.data.permalink).toBe("https://example.slack.com/archives/C1/p1700000000000200");
    }
  });

  it("rejects a malformed event source", () => {
    const result = automationEventSchema.safeParse({
      source: "email",
      eventType: "message.posted",
      triggerKey: "event-1",
      concurrencyKey: "event-1",
      contextBlock: "Context",
      meta: {},
    });

    expect(result.success).toBe(false);
  });

  it("rejects a partial GitHub automation event", () => {
    const result = automationEventSchema.safeParse({
      source: "github",
      eventType: "pull_request.opened",
      triggerKey: "github:pr:1",
      concurrencyKey: "github:pr:1",
      contextBlock: "A pull request was opened.",
      meta: {},
      repoOwner: "acme",
      repositoryId: 9001,
    });

    expect(result.success).toBe(false);
  });

  it("exports source-specific schemas", () => {
    const result = githubAutomationEventSchema.safeParse({
      source: "github",
      eventType: "pull_request.opened",
      triggerKey: "github:pr:1",
      concurrencyKey: "github:pr:1",
      contextBlock: "A pull request was opened.",
      meta: {},
      repoOwner: "acme",
      repoName: "web-app",
      repositoryId: 9001,
    });

    expect(result.success).toBe(true);
  });

  it("accepts both GitHub conclusion fields during rolling deployments", () => {
    const baseEvent = {
      source: "github" as const,
      eventType: "check_suite.completed",
      triggerKey: "check_suite:1",
      concurrencyKey: "check_suite:1",
      contextBlock: "A check suite completed.",
      meta: {},
      repoOwner: "acme",
      repoName: "web-app",
      repositoryId: 9001,
    };

    expect(
      githubAutomationEventSchema.safeParse({ ...baseEvent, conclusion: "failure" }).success
    ).toBe(true);
    expect(
      githubAutomationEventSchema.safeParse({ ...baseEvent, checkConclusion: "failure" }).success
    ).toBe(true);
  });

  it("rejects optional arrays with non-string values", () => {
    const result = automationEventSchema.safeParse({
      source: "linear",
      eventType: "issue.created",
      triggerKey: "linear:issue:1",
      concurrencyKey: "linear:issue:1",
      contextBlock: "A Linear issue was created.",
      meta: {},
      repoOwner: "acme",
      repoName: "web-app",
      labels: ["bug", 123],
    });

    expect(result.success).toBe(false);
  });
});

describe("GitHub automation repository identity", () => {
  it.each([1, 9001, Number.MAX_SAFE_INTEGER])(
    "preserves a positive safe integer repositoryId=%s",
    (repositoryId) => {
      const event = { ...buildMockEvent("github"), repositoryId };
      expect(githubAutomationEventSchema.parse(event)).toEqual(event);
      expect(automationEventSchema.parse(event)).toEqual(event);
    }
  );

  it.each([undefined, null, "9001", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects repositoryId=%s even when owner/name and PR lifecycle identity are present",
    (repositoryId) => {
      const event = {
        ...buildMockEvent("github"),
        repositoryId,
        pullRequest: { number: 42, repositoryExternalId: "9001" },
      };
      expect(githubAutomationEventSchema.safeParse(event).success).toBe(false);
      expect(automationEventSchema.safeParse(event).success).toBe(false);
    }
  );

  it("builds valid shared GitHub fixtures with a required repository id", () => {
    expect(githubAutomationEventSchema.parse(buildMockEvent("github"))).toHaveProperty(
      "repositoryId",
      9001
    );
  });

  it("keeps PR lifecycle repositoryExternalId string-compatible", () => {
    const event = {
      ...buildMockEvent("github"),
      pullRequest: { number: 42, repositoryExternalId: "9001" },
    };

    expect(githubAutomationEventSchema.parse(event)).toEqual(event);
    expect(
      githubAutomationEventSchema.safeParse({
        ...event,
        pullRequest: { ...event.pullRequest, repositoryExternalId: 9001 },
      }).success
    ).toBe(false);
  });

  it("does not require a GitHub repository id on Linear events", () => {
    const event = buildMockEvent("linear");
    expect(automationEventSchema.parse(event)).toEqual(event);
    expect(event).not.toHaveProperty("repositoryId");
  });
});

describe("persisted webhook filters", () => {
  it("preserves scalar values accepted by existing editors and API clients", () => {
    const config = {
      conditions: [
        {
          type: "jsonpath",
          operator: "all_match",
          value: [
            { path: "$.count", comparison: "gt", value: "3" },
            { path: "$.count", comparison: "gte", value: true },
            { path: "$.name", comparison: "contains", value: 3 },
            { path: "$.name", comparison: "exists" },
          ],
        },
      ],
    };
    expect(triggerConfigSchema.parse(config)).toEqual(config);
  });

  it.each([null, [], {}])("rejects non-scalar filter values: %j", (value) => {
    expect(
      triggerConfigSchema.safeParse({
        conditions: [
          {
            type: "jsonpath",
            operator: "all_match",
            value: [{ path: "$.count", comparison: "gt", value }],
          },
        ],
      }).success
    ).toBe(false);
  });
});
