import { describe, expect, it } from "vitest";
import { stripMentions, isDmDispatchable, isChannelTriggerCandidate } from "./dm-utils";

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

  it("returns true for a file_share message with text", () => {
    expect(isDmDispatchable({ ...baseEvent, subtype: "file_share" })).toBe(true);
  });

  it("returns true for a text-less file_share message with files", () => {
    expect(
      isDmDispatchable({ ...baseEvent, subtype: "file_share", text: undefined, files: [{}] })
    ).toBe(true);
  });

  it("returns false for a text-less file_share message without files", () => {
    expect(isDmDispatchable({ ...baseEvent, subtype: "file_share", text: undefined })).toBe(false);
  });

  it("still rejects other subtypes even when files are present", () => {
    expect(isDmDispatchable({ ...baseEvent, subtype: "message_changed", files: [{}] })).toBe(false);
  });
});

describe("isChannelTriggerCandidate", () => {
  const BOT = "UBOT123";
  const baseEvent = {
    type: "message",
    channel_type: "channel",
    text: "the deploy job is failing again",
    channel: "C12345",
    ts: "1234567890.123456",
    user: "U99999",
  };

  it("returns true for a plain public-channel message", () => {
    expect(isChannelTriggerCandidate(baseEvent, BOT)).toBe(true);
  });

  it("returns true for a private-channel (group) message", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, channel_type: "group" }, BOT)).toBe(true);
  });

  it("returns false for DM and group-DM channel types", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, channel_type: "im" }, BOT)).toBe(false);
    expect(isChannelTriggerCandidate({ ...baseEvent, channel_type: "mpim" }, BOT)).toBe(false);
  });

  it("returns false when a subtype is present (edits, joins, bot posts)", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, subtype: "message_changed" }, BOT)).toBe(
      false
    );
    expect(isChannelTriggerCandidate({ ...baseEvent, subtype: "channel_join" }, BOT)).toBe(false);
  });

  it("returns false when bot_id is set", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, bot_id: "B1" }, BOT)).toBe(false);
  });

  it("returns false when required fields are missing", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, text: undefined }, BOT)).toBe(false);
    expect(isChannelTriggerCandidate({ ...baseEvent, channel: undefined }, BOT)).toBe(false);
    expect(isChannelTriggerCandidate({ ...baseEvent, ts: undefined }, BOT)).toBe(false);
    expect(isChannelTriggerCandidate({ ...baseEvent, user: undefined }, BOT)).toBe(false);
  });

  it("returns false for the bot's own messages", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, user: BOT }, BOT)).toBe(false);
  });

  it("suppresses messages that mention the bot (handled by app_mention)", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, text: `<@${BOT}> please deploy` }, BOT)).toBe(
      false
    );
    // piped rendering <@UBOT123|assistant>
    expect(
      isChannelTriggerCandidate({ ...baseEvent, text: `<@${BOT}|assistant> deploy` }, BOT)
    ).toBe(false);
  });

  it("still triggers when a different user is mentioned", () => {
    expect(
      isChannelTriggerCandidate({ ...baseEvent, text: "<@U55555> can you deploy?" }, BOT)
    ).toBe(true);
  });

  it("returns false for app_mention event type", () => {
    expect(isChannelTriggerCandidate({ ...baseEvent, type: "app_mention" }, BOT)).toBe(false);
  });
});
