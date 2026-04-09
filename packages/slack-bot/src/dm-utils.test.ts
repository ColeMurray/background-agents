import { describe, expect, it } from "vitest";
import { stripMentions, isDmDispatchable } from "./dm-utils";

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

describe("isDmDispatchable", () => {
  const baseEvent = {
    type: "message",
    channel_type: "im",
    text: "hello",
    channel: "D12345",
    ts: "1234567890.123456",
    user: "U12345",
  };

  it("returns true for a valid DM event", () => {
    expect(isDmDispatchable(baseEvent)).toBe(true);
  });

  it("returns false when subtype is present (e.g. bot_message)", () => {
    expect(isDmDispatchable({ ...baseEvent, subtype: "bot_message" })).toBe(false);
  });

  it("returns false when subtype is message_changed", () => {
    expect(isDmDispatchable({ ...baseEvent, subtype: "message_changed" })).toBe(false);
  });

  it("returns false for non-im channel type", () => {
    expect(isDmDispatchable({ ...baseEvent, channel_type: "channel" })).toBe(false);
  });

  it("returns false when text is missing", () => {
    expect(isDmDispatchable({ ...baseEvent, text: undefined })).toBe(false);
  });

  it("returns false when user is missing", () => {
    expect(isDmDispatchable({ ...baseEvent, user: undefined })).toBe(false);
  });

  it("returns false for non-message event type", () => {
    expect(isDmDispatchable({ ...baseEvent, type: "app_mention" })).toBe(false);
  });
});
