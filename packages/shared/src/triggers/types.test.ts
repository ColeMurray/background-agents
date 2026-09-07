import { describe, expect, it } from "vitest";
import { automationEventSchema, githubAutomationEventSchema, jsonPathFilterSchema } from "./types";

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

describe("jsonPathFilterSchema", () => {
  it("parses numeric comparison filters", () => {
    expect(jsonPathFilterSchema.safeParse({ path: "$.count", comparison: "gt", value: 3 })).toEqual(
      {
        success: true,
        data: { path: "$.count", comparison: "gt", value: 3 },
      }
    );
  });

  it("parses string contains filters", () => {
    expect(
      jsonPathFilterSchema.safeParse({ path: "$.name", comparison: "contains", value: "deploy" })
    ).toEqual({
      success: true,
      data: { path: "$.name", comparison: "contains", value: "deploy" },
    });
  });

  it("rejects malformed comparison values", () => {
    expect(
      jsonPathFilterSchema.safeParse({ path: "$.count", comparison: "gt", value: "3" }).success
    ).toBe(false);
    expect(
      jsonPathFilterSchema.safeParse({ path: "$.name", comparison: "contains", value: 3 }).success
    ).toBe(false);
  });

  it("rejects partial numeric filters", () => {
    expect(jsonPathFilterSchema.safeParse({ path: "$.count", comparison: "gt" }).success).toBe(
      false
    );
  });

  it("parses exists filters without a value", () => {
    expect(jsonPathFilterSchema.safeParse({ path: "$.name", comparison: "exists" })).toEqual({
      success: true,
      data: { path: "$.name", comparison: "exists" },
    });
  });
});
