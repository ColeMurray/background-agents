import { describe, expect, it } from "vitest";
import { isValidSessionLifecyclePayload } from "./callbacks";

const VALID_PAYLOAD = {
  sessionId: "sess-1",
  event: "archived" as const,
  actorAuthorId: "web:user-1",
  timestamp: Date.now(),
  signature: "abc123",
  context: {
    source: "slack" as const,
    channel: "C1",
    threadTs: "1.2",
    repoFullName: "acme/web",
    model: "claude-sonnet-4-5",
  },
};

describe("isValidSessionLifecyclePayload", () => {
  it("accepts a complete archived payload", () => {
    expect(isValidSessionLifecyclePayload(VALID_PAYLOAD)).toBe(true);
  });

  it("accepts an unarchived event", () => {
    expect(isValidSessionLifecyclePayload({ ...VALID_PAYLOAD, event: "unarchived" })).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidSessionLifecyclePayload(null)).toBe(false);
  });

  it("rejects an unknown event", () => {
    expect(isValidSessionLifecyclePayload({ ...VALID_PAYLOAD, event: "deleted" })).toBe(false);
  });

  it("rejects when signature is missing", () => {
    const { signature: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidSessionLifecyclePayload(rest)).toBe(false);
  });

  it("rejects context without channel + threadTs (must be a Slack callback context)", () => {
    expect(
      isValidSessionLifecyclePayload({
        ...VALID_PAYLOAD,
        context: { ...VALID_PAYLOAD.context, channel: undefined },
      })
    ).toBe(false);
  });

  it("rejects when sessionId is missing", () => {
    const { sessionId: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidSessionLifecyclePayload(rest)).toBe(false);
  });
});
