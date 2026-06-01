import { describe, expect, it } from "vitest";
import { formatCrossChannelActor, isValidPlanStatusPayload } from "./callbacks";

// ─── isValidPlanStatusPayload ────────────────────────────────────────────────

const VALID_PAYLOAD = {
  sessionId: "sess-1",
  planVersion: 3,
  plan: {
    id: "plan-1",
    version: 3,
    content: "step 1",
    createdByAuthorId: null,
    createdByMessageId: "msg-1",
    source: "agent" as const,
    createdAt: 1_700_000_000_000,
  },
  verdict: "approved" as const,
  approverAuthorId: "web:user-1",
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

describe("isValidPlanStatusPayload", () => {
  it("accepts a complete valid payload", () => {
    expect(isValidPlanStatusPayload(VALID_PAYLOAD)).toBe(true);
  });

  it("accepts a rejected verdict with a reason", () => {
    expect(
      isValidPlanStatusPayload({ ...VALID_PAYLOAD, verdict: "rejected", reason: "scope too big" })
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidPlanStatusPayload(null)).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(isValidPlanStatusPayload({ ...VALID_PAYLOAD, verdict: "maybe" })).toBe(false);
  });

  it("rejects when planVersion is not a number", () => {
    expect(isValidPlanStatusPayload({ ...VALID_PAYLOAD, planVersion: "3" })).toBe(false);
  });

  it("rejects when context is missing", () => {
    const { context: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidPlanStatusPayload(rest)).toBe(false);
  });

  it("rejects when signature is missing", () => {
    const { signature: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidPlanStatusPayload(rest)).toBe(false);
  });

  it("rejects when plan is null", () => {
    expect(isValidPlanStatusPayload({ ...VALID_PAYLOAD, plan: null })).toBe(false);
  });
});

// ─── formatCrossChannelActor ─────────────────────────────────────────────────

describe("formatCrossChannelActor", () => {
  it("uses the display name when provided, suffixed with the channel source", () => {
    expect(formatCrossChannelActor("web:user-1", "John Doe")).toBe("John Doe (via web)");
  });

  it("returns the display name without suffix when source can't be parsed", () => {
    expect(formatCrossChannelActor(null, "John Doe")).toBe("John Doe");
    expect(formatCrossChannelActor("no-prefix-id", "John Doe")).toBe("John Doe");
  });

  it("falls back to 'someone in <source>' when displayName is missing", () => {
    expect(formatCrossChannelActor("web:user-1")).toBe("someone in web");
    expect(formatCrossChannelActor("linear:agent-123")).toBe("someone in linear");
  });

  it("treats blank-only displayName as missing", () => {
    expect(formatCrossChannelActor("web:user-1", "   ")).toBe("someone in web");
    expect(formatCrossChannelActor("web:user-1", "")).toBe("someone in web");
  });

  it("returns 'someone' for null without displayName", () => {
    expect(formatCrossChannelActor(null)).toBe("someone");
  });

  it("returns 'someone' for an id with no prefix and no displayName", () => {
    expect(formatCrossChannelActor("just-an-id")).toBe("someone");
  });
});
