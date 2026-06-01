import { describe, expect, it } from "vitest";
import { isValidSessionLifecyclePayload } from "./callbacks";

const VALID_PAYLOAD = {
  sessionId: "sess-1",
  event: "archived" as const,
  actorAuthorId: "web:user-1",
  timestamp: Date.now(),
  signature: "abc123",
  context: {
    source: "linear" as const,
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    issueUrl: "https://linear.app/issue/ENG-42",
    repoFullName: "acme/web",
    model: "claude-sonnet-4-5",
    agentSessionId: "agent-sess-1",
    organizationId: "org-1",
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

  it("rejects context without issueId (must be a Linear callback context)", () => {
    expect(
      isValidSessionLifecyclePayload({
        ...VALID_PAYLOAD,
        context: { ...VALID_PAYLOAD.context, issueId: undefined },
      })
    ).toBe(false);
  });

  it("rejects when signature is missing", () => {
    const { signature: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidSessionLifecyclePayload(rest)).toBe(false);
  });
});
