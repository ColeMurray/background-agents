import { describe, it, expect } from "vitest";
import { normalizeSlackEvent, SLACK_TEXT_MAX_LENGTH } from "./normalizer";

const baseInput = {
  channel: "C123",
  ts: "1700000000.000100",
  user: "U999",
  text: "please deploy the api",
};

describe("normalizeSlackEvent", () => {
  it("normalizes a valid channel message", () => {
    const event = normalizeSlackEvent(baseInput, "UBOT", {
      channelName: "ops",
      permalink: "https://example.slack.com/archives/C123/p1700000000000100",
    });
    expect(event).not.toBeNull();
    expect(event!.source).toBe("slack");
    expect(event!.eventType).toBe("message.posted");
    expect(event!.channelId).toBe("C123");
    expect(event!.channelName).toBe("ops");
    expect(event!.actorUserId).toBe("U999");
    expect(event!.ts).toBe("1700000000.000100");
    expect(event!.text).toBe("please deploy the api");
    expect(event!.triggerKey).toBe("slack:msg:C123:1700000000.000100");
    expect(event!.concurrencyKey).toBe("slack:C123:1700000000.000100");
    expect(event!.contextBlock).toContain("please deploy the api");
    expect(event!.contextBlock).toContain("ops");
  });

  it("uses thread_ts for the concurrency key on a thread reply", () => {
    const event = normalizeSlackEvent({ ...baseInput, thread_ts: "1699999999.000001" }, "UBOT");
    expect(event!.threadTs).toBe("1699999999.000001");
    expect(event!.concurrencyKey).toBe("slack:C123:1699999999.000001");
    // triggerKey stays keyed on the message ts (one run per message).
    expect(event!.triggerKey).toBe("slack:msg:C123:1700000000.000100");
  });

  it("returns null for empty/whitespace text", () => {
    expect(normalizeSlackEvent({ ...baseInput, text: "   " }, "UBOT")).toBeNull();
    expect(normalizeSlackEvent({ ...baseInput, text: "" }, "UBOT")).toBeNull();
  });

  it("strips the bot's own bare mention <@BOT>", () => {
    const event = normalizeSlackEvent({ ...baseInput, text: "<@UBOT> please deploy" }, "UBOT");
    expect(event!.text).toBe("please deploy");
    expect(event!.text).not.toContain("UBOT");
  });

  it("strips the bot's piped mention <@BOT|name>", () => {
    const event = normalizeSlackEvent(
      { ...baseInput, text: "<@UBOT|open-inspect> please deploy" },
      "UBOT"
    );
    expect(event!.text).toBe("please deploy");
    expect(event!.text).not.toContain("UBOT");
  });

  it("returns null when the message is only the bot mention", () => {
    expect(normalizeSlackEvent({ ...baseInput, text: "<@UBOT>" }, "UBOT")).toBeNull();
    expect(normalizeSlackEvent({ ...baseInput, text: "<@UBOT|open-inspect>" }, "UBOT")).toBeNull();
  });

  it("does not strip other users' mentions", () => {
    const event = normalizeSlackEvent({ ...baseInput, text: "<@UBOT> ping <@U777>" }, "UBOT");
    expect(event!.text).toContain("<@U777>");
  });

  it("caps text at SLACK_TEXT_MAX_LENGTH", () => {
    const event = normalizeSlackEvent(
      { ...baseInput, text: "x".repeat(SLACK_TEXT_MAX_LENGTH + 500) },
      "UBOT"
    );
    expect(event!.text.length).toBe(SLACK_TEXT_MAX_LENGTH);
  });

  it("falls back to the channel id when no channel name is supplied", () => {
    const event = normalizeSlackEvent(baseInput, "UBOT");
    expect(event!.channelName).toBeUndefined();
    expect(event!.contextBlock).toContain("C123");
  });
});
