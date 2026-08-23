import { describe, expect, it } from "vitest";
import { sessionCallbackJobSchema } from "./session-callback-jobs";

const completedPayload = {
  sessionId: "session-1",
  messageId: "message-1",
  source: "slack",
  success: true,
  timestamp: 1_700_000_000_000,
  context: {},
};

describe("sessionCallbackJobSchema", () => {
  it.each(["session.completed", "session.started", "tool_call"])(
    "accepts the %s envelope",
    (type) => {
      const payloads = {
        "session.completed": {
          sessionId: "session-1",
          messageId: "message-1",
          source: "slack",
          success: true,
          timestamp: 1_700_000_000_000,
          context: {},
        },
        "session.started": {
          sessionId: "session-1",
          messageId: "message-1",
          timestamp: 1_700_000_000_000,
          context: {},
        },
        tool_call: {
          sessionId: "session-1",
          messageId: "message-1",
          source: "slack",
          tool: "bash",
          args: {},
          callId: "call-1",
          timestamp: 1_700_000_000_000,
          context: {},
        },
      } as const;

      expect(
        sessionCallbackJobSchema.safeParse({ version: 1, type, payload: payloads[type] }).success
      ).toBe(true);
    }
  );

  it("rejects unsupported versions", () => {
    expect(
      sessionCallbackJobSchema.safeParse({
        version: 2,
        type: "session.completed",
        payload: completedPayload,
      }).success
    ).toBe(false);
  });

  it("rejects signatures in the unsigned job payload", () => {
    expect(
      sessionCallbackJobSchema.safeParse({
        version: 1,
        type: "session.completed",
        payload: { ...completedPayload, signature: "must-not-enter-the-queue" },
      }).success
    ).toBe(false);
  });
});
