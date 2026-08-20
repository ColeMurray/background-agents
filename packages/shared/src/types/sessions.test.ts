import { describe, expect, it } from "vitest";
import { sessionReadActionSchema, sessionReadResultSchema } from "./sessions";

describe("session read contracts", () => {
  it("accepts only explicit exact and latest read actions", () => {
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_message_read",
        messageId: "message-1",
      }).success
    ).toBe(true);
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_latest_message_read",
      }).success
    ).toBe(true);
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_latest_message_read",
        messageId: "message-1",
      }).success
    ).toBe(false);
  });

  it("rejects unread state without a terminal message", () => {
    expect(
      sessionReadResultSchema.safeParse({
        sessionId: "session-1",
        outcome: "no_terminal_message",
        unread: true,
        latestMessageId: null,
      }).success
    ).toBe(false);
  });
});
