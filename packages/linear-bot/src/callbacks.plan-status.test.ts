import { describe, expect, it } from "vitest";
import { formatCrossChannelActor, isValidPlanStatusPayload } from "./callbacks";

// ─── isValidPlanStatusPayload ────────────────────────────────────────────────

const VALID_PAYLOAD = {
  sessionId: "sess-1",
  planVersion: 2,
  plan: {
    id: "plan-1",
    version: 2,
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

describe("isValidPlanStatusPayload", () => {
  it("accepts a complete valid payload", () => {
    expect(isValidPlanStatusPayload(VALID_PAYLOAD)).toBe(true);
  });

  it("accepts a rejected verdict with a reason", () => {
    expect(
      isValidPlanStatusPayload({ ...VALID_PAYLOAD, verdict: "rejected", reason: "out of scope" })
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidPlanStatusPayload(null)).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(isValidPlanStatusPayload({ ...VALID_PAYLOAD, verdict: "pending" })).toBe(false);
  });

  it("rejects context without issueId (must be a Linear callback context)", () => {
    expect(
      isValidPlanStatusPayload({
        ...VALID_PAYLOAD,
        context: { ...VALID_PAYLOAD.context, issueId: undefined },
      })
    ).toBe(false);
  });

  it("rejects when signature is missing", () => {
    const { signature: _omitted, ...rest } = VALID_PAYLOAD;
    expect(isValidPlanStatusPayload(rest)).toBe(false);
  });
});

// ─── formatCrossChannelActor ─────────────────────────────────────────────────

describe("formatCrossChannelActor", () => {
  it("collapses 'web:userId' to 'someone in web'", () => {
    expect(formatCrossChannelActor("web:user-1")).toBe("someone in web");
  });

  it("collapses 'slack:U123' to 'someone in slack'", () => {
    expect(formatCrossChannelActor("slack:U123")).toBe("someone in slack");
  });

  it("returns 'someone' for null", () => {
    expect(formatCrossChannelActor(null)).toBe("someone");
  });

  it("returns 'someone' for a string without a prefix", () => {
    expect(formatCrossChannelActor("just-an-id")).toBe("someone");
  });
});
