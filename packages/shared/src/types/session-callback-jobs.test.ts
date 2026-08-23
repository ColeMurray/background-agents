import { describe, expect, it } from "vitest";
import { sessionCallbackJobSchema } from "./session-callback-jobs";

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
          context: {},
        },
        "session.started": {
          sessionId: "session-1",
          messageId: "message-1",
          context: {},
        },
        tool_call: {
          sessionId: "session-1",
          messageId: "message-1",
          source: "slack",
          tool: "bash",
          args: {},
          callId: "call-1",
          context: {},
        },
      } as const;

      expect(
        sessionCallbackJobSchema.safeParse({ version: 1, type, payload: payloads[type] }).success
      ).toBe(true);
    }
  );

  it("rejects unknown fields and versions", () => {
    expect(
      sessionCallbackJobSchema.safeParse({
        version: 2,
        type: "session.completed",
        payload: {
          sessionId: "session-1",
          messageId: "message-1",
          source: "slack",
          success: true,
          context: {},
          signature: "must-not-enter-the-queue",
        },
      }).success
    ).toBe(false);
  });
});
