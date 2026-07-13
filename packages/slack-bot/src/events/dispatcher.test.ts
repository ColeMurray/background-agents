import { describe, expect, it } from "vitest";
import { slackEventPayloadSchema } from "./dispatcher";

describe("slackEventPayloadSchema", () => {
  it("parses a valid Slack event callback payload", () => {
    const result = slackEventPayloadSchema.safeParse({
      type: "event_callback",
      event_id: "Ev123",
      event: {
        type: "app_mention",
        text: "<@B123> investigate this",
        user: "U123",
        channel: "C123",
        ts: "111.222",
        attachments: [{ text: "context", footer: "Slack" }],
      },
    });

    expect(result.success).toBe(true);
  });

  it("parses URL verification payloads without an event object", () => {
    const result = slackEventPayloadSchema.safeParse({
      type: "url_verification",
      challenge: "challenge-token",
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed partial event payloads", () => {
    const result = slackEventPayloadSchema.safeParse({
      type: "event_callback",
      event_id: 123,
      event: { text: "missing type" },
    });

    expect(result.success).toBe(false);
  });
});
