import { describe, expect, it } from "vitest";
import { stripMentions, isPrivateMessageDispatchable } from "./dm-utils";

describe("stripMentions", () => {
  it("removes a single mention", () => {
    expect(stripMentions("<@U12345> fix this bug")).toBe("fix this bug");
  });

  it("removes multiple mentions", () => {
    expect(stripMentions("<@U12345> and <@U67890> help me")).toBe("and help me");
    expect(stripMentions("<@ABC123> <@DEF456> hello")).toBe("hello");
  });

  it("handles mention-only text (returns empty string)", () => {
    expect(stripMentions("<@U12345>")).toBe("");
  });

  it("leaves text without mentions unchanged", () => {
    expect(stripMentions("fix the login bug")).toBe("fix the login bug");
  });

  it("trims surrounding whitespace", () => {
    expect(stripMentions("  hello world  ")).toBe("hello world");
  });

  it("does not strip lowercase or invalid mention-like patterns", () => {
    expect(stripMentions("<@u12345> lowercase")).toBe("<@u12345> lowercase");
    expect(stripMentions("<#C12345> channel ref")).toBe("<#C12345> channel ref");
  });
});

describe("isPrivateMessageDispatchable", () => {
  const baseEvent = {
    type: "message",
    channel_type: "im",
    text: "hello",
    channel: "D12345",
    ts: "1234567890.123456",
    user: "U12345",
  };

  it("returns true for a valid DM (im) event", () => {
    expect(isPrivateMessageDispatchable(baseEvent)).toBe(true);
  });

  it("returns true for a valid group DM (mpim) event", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, channel_type: "mpim" })).toBe(true);
  });

  it("returns false when subtype is present (e.g. bot_message)", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, subtype: "bot_message" })).toBe(false);
  });

  it("returns false when subtype is message_changed", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, subtype: "message_changed" })).toBe(false);
  });

  it("returns false for a public channel event", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, channel_type: "channel" })).toBe(false);
  });

  it("returns false when text is missing", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, text: undefined })).toBe(false);
  });

  it("returns false when user is missing", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, user: undefined })).toBe(false);
  });

  it("returns false for non-message event type", () => {
    expect(isPrivateMessageDispatchable({ ...baseEvent, type: "app_mention" })).toBe(false);
  });
});
