import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../routes/shared";
import { logAutomationEventRejection, validateAutomationEventEnvelope } from "./automation-event";

function makeSlackEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: "slack:msg:C1:1700000000.000200",
    concurrencyKey: "slack:C1:1700000000.000100",
    contextBlock: "A message was posted in #ops.",
    meta: {},
    channelId: "C1",
    ts: "1700000000.000200",
    actorUserId: "U1",
    text: "please deploy the api",
    ...overrides,
  };
}

describe("validateAutomationEventEnvelope", () => {
  it.each([
    ["eventType", { nested: "value" }],
    ["triggerKey", ["not", "a", "string"]],
    ["concurrencyKey", { key: "value" }],
    ["contextBlock", ["context"]],
    ["meta", []],
    ["channelId", { id: "C1" }],
    ["ts", ["1700000000.000200"]],
    ["actorUserId", { id: "U1" }],
    ["text", ["deploy"]],
  ])("rejects a non-protocol value for %s", async (field, value) => {
    const result = validateAutomationEventEnvelope(makeSlackEvent({ [field]: value }), "slack");

    expect(result.response?.status).toBe(400);
    expect(await result.response?.text()).toContain(field);
  });

  it("returns a typed event without unknown envelope fields", () => {
    const result = validateAutomationEventEnvelope(
      makeSlackEvent({ untrustedAdditionalField: "discard me" }),
      "slack"
    );

    expect(result.response).toBeUndefined();
    expect(result.event).toEqual(makeSlackEvent());
    expect(result.event?.source).toBe("slack");
  });

  it.each(["eventType", "triggerKey", "concurrencyKey", "channelId", "ts"])(
    "rejects an empty required field for %s",
    async (field) => {
      const result = validateAutomationEventEnvelope(makeSlackEvent({ [field]: "" }), "slack");

      expect(result.response?.status).toBe(400);
      expect(await result.response?.text()).toContain(field);
    }
  );

  it("rejects source-specific fields from a different event variant", async () => {
    const result = validateAutomationEventEnvelope(
      {
        source: "github",
        eventType: "pull_request.opened",
        triggerKey: "github:pr:1",
        concurrencyKey: "github:pr:1",
        contextBlock: "A pull request was opened.",
        meta: {},
        repoOwner: { login: "acme" },
        repoName: "api",
      },
      "github"
    );

    expect(result.response?.status).toBe(400);
    expect(await result.response?.text()).toContain("repoOwner");
  });
});

describe("logAutomationEventRejection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs safe protocol and request correlation fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logAutomationEventRejection(
      makeSlackEvent({ eventType: "x".repeat(200), channelId: [] }),
      "slack",
      ["channelId"],
      { request_id: "request-1", trace_id: "trace-1" } as RequestContext
    );

    const entry = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: "automation_event.ingress_rejected",
      source: "slack",
      event_type: "x".repeat(128),
      issue_paths: ["channelId"],
      request_id: "request-1",
      trace_id: "trace-1",
    });
  });
});
