import { describe, expect, it } from "vitest";
import { buildWorkingMessage, formatSessionDefaultsNotice } from "./blocks";

describe("buildWorkingMessage", () => {
  it("uses concise target-neutral copy", () => {
    expect(buildWorkingMessage()).toEqual({
      text: "Starting work...",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Starting work..." },
        },
      ],
    });
  });

  it("includes a session link when provided", () => {
    expect(
      buildWorkingMessage({
        sessionId: "session-1",
        webAppUrl: "https://app.example.com",
      })
    ).toEqual({
      text: "Starting work...",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Starting work..." },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Session" },
              url: "https://app.example.com/session/session-1",
              action_id: "view_session",
            },
          ],
        },
      ],
    });
  });

  // Slack falls back to `text` for notifications and screen readers, so the
  // notice has to appear there too, not only in Block Kit.
  it("carries a session defaults notice in both text and blocks", () => {
    expect(
      buildWorkingMessage({
        sessionDefaultsNotice: "Session defaults: Claude Haiku 4.5 · high reasoning",
      })
    ).toEqual({
      text: "Starting work...\nSession defaults: Claude Haiku 4.5 · high reasoning",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Starting work..." },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "Session defaults: Claude Haiku 4.5 · high reasoning" },
          ],
        },
      ],
    });
  });
});

describe("formatSessionDefaultsNotice", () => {
  it("stays silent when the session runs the user's own defaults", () => {
    expect(
      formatSessionDefaultsNotice({
        sessionDefaults: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
        differsFromUserDefaults: false,
      })
    ).toBeUndefined();
  });

  it("names the model and reasoning the session was created with", () => {
    expect(
      formatSessionDefaultsNotice({
        sessionDefaults: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "max" },
        differsFromUserDefaults: true,
      })
    ).toBe("Session defaults: Claude Haiku 4.5 · max reasoning");
  });

  it("omits reasoning for models that do not support it", () => {
    expect(
      formatSessionDefaultsNotice({
        sessionDefaults: { model: "anthropic/claude-haiku-4-5" },
        differsFromUserDefaults: true,
      })
    ).toBe("Session defaults: Claude Haiku 4.5");
  });
});
