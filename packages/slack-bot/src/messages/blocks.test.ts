import { describe, expect, it } from "vitest";
import type { ResolvedTurnPlan } from "../inline-flags";
import { buildWorkingMessageBlocks, formatSessionDefaultsNotice } from "./blocks";

function turnPlan(
  sessionDefaults: ResolvedTurnPlan["sessionDefaults"],
  effective: ResolvedTurnPlan["effective"]
): ResolvedTurnPlan {
  return { sessionDefaults, promptOverrides: {}, effective };
}

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

  it("carries a session defaults notice without adding a message", () => {
    expect(
      buildWorkingMessageBlocks({
        sessionDefaultsNotice: "Session defaults: Claude Haiku 4.5 · high reasoning",
      })
    ).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Starting work..." },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Session defaults: Claude Haiku 4.5 · high reasoning" }],
      },
    ]);
  });
});

describe("formatSessionDefaultsNotice", () => {
  const defaults = { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" } as const;

  it("stays silent when the session runs the user's own defaults", () => {
    expect(formatSessionDefaultsNotice(turnPlan(defaults, defaults))).toBeUndefined();
  });

  it("names the model and reasoning a flag switched the session to", () => {
    expect(
      formatSessionDefaultsNotice(
        turnPlan(defaults, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "max" })
      )
    ).toBe("Session defaults: Claude Haiku 4.5 · max reasoning");
  });

  it("reports a reasoning-only change against the unchanged model", () => {
    expect(
      formatSessionDefaultsNotice(
        turnPlan(defaults, { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "max" })
      )
    ).toBe("Session defaults: Claude Sonnet 4.6 · max reasoning");
  });

  it("omits reasoning for models that do not support it", () => {
    expect(
      formatSessionDefaultsNotice(turnPlan(defaults, { model: "anthropic/claude-haiku-4-5" }))
    ).toBe("Session defaults: Claude Haiku 4.5");
  });
});
