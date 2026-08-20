import { describe, expect, it } from "vitest";
import { sessionReadActionSchema, sessionReadResultSchema } from "./sessions";
import { createSessionRequestSchema } from "./session-api";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

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

describe("createSessionRequestSchema provider selections", () => {
  it("accepts omitted, empty, and explicit provider selections", () => {
    expect(createSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(createSessionRequestSchema.safeParse({ providerSelections: {} }).success).toBe(true);
    expect(
      createSessionRequestSchema.safeParse({
        providerSelections: {
          openai: { mode: "provider_account", accountId: ACCOUNT_ID },
          xai: { mode: "api_key" },
        },
      }).success
    ).toBe(true);
  });

  it("rejects malformed provider selections", () => {
    expect(
      createSessionRequestSchema.safeParse({
        providerSelections: { anthropic: { mode: "api_key" } },
      }).success
    ).toBe(false);
  });
});
