import { describe, expect, it } from "vitest";
import { automationEventSchema } from "./types";

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
      threadTs: "1700000000.000100",
      ts: "1700000000.000200",
      actorUserId: "U1",
      text: "please deploy the api",
    });

    expect(result.success).toBe(true);
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
