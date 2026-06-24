import { describe, expect, it } from "vitest";
import { slackNotifyToolEnvelopeSchema } from "./types";

describe("slack notify tool envelope schema", () => {
  it("parses a valid success envelope", () => {
    const result = slackNotifyToolEnvelopeSchema.safeParse({
      ok: true,
      channelInput: "#deploys",
      channelId: "C123",
      messageTs: "1710000000.000000",
      permalink: "https://example.slack.com/archives/C123/p1710000000000000",
      truncated: false,
      strippedBroadcasts: false,
      mentionsModified: false,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a malformed partial success envelope", () => {
    const result = slackNotifyToolEnvelopeSchema.safeParse({
      ok: true,
      channelInput: "#deploys",
    });

    expect(result.success).toBe(false);
  });

  it("parses a valid denial envelope with an omitted retry window", () => {
    const result = slackNotifyToolEnvelopeSchema.safeParse({
      ok: false,
      reason: "channel_not_found_or_forbidden",
      agentMessage: "Invite the bot to the channel and try again.",
    });

    expect(result.success).toBe(true);
  });
});
