import { describe, expect, it } from "vitest";
import { buildWorkingMessageBlocks } from "./blocks";

describe("buildWorkingMessageBlocks", () => {
  it("uses concise target-neutral copy", () => {
    expect(buildWorkingMessageBlocks()).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Starting work..." },
      },
    ]);
  });

  it("includes a session link when provided", () => {
    expect(
      buildWorkingMessageBlocks({
        sessionId: "session-1",
        webAppUrl: "https://app.example.com",
      })
    ).toEqual([
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
    ]);
  });
});
