import { describe, it, expect } from "vitest";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  type SlackRunCoords,
} from "./slack-completion";

function coords(overrides?: Partial<SlackRunCoords>): SlackRunCoords {
  return {
    slack_channel: "C1",
    slack_thread_ts: null,
    slack_message_ts: "1700000000.000100",
    session_id: "sess-1",
    ...overrides,
  };
}

describe("buildSlackCompletionNotification", () => {
  it("returns null for a non-slack run (no channel)", () => {
    expect(
      buildSlackCompletionNotification({
        run: coords({ slack_channel: null }),
        automationName: "Triage",
        success: true,
      })
    ).toBeNull();
  });

  it("returns null when a slack run has no thread anchor", () => {
    expect(
      buildSlackCompletionNotification({
        run: coords({ slack_thread_ts: null, slack_message_ts: null }),
        automationName: "Triage",
        success: true,
      })
    ).toBeNull();
  });

  it("anchors to the thread ts when present", () => {
    const n = buildSlackCompletionNotification({
      run: coords({ slack_thread_ts: "1699999999.000001" }),
      automationName: "Triage",
      success: true,
    });
    expect(n).toMatchObject({
      channel: "C1",
      threadTs: "1699999999.000001",
      reactionMessageTs: "1700000000.000100",
      sessionId: "sess-1",
      success: true,
      automationName: "Triage",
    });
    expect(n?.summary).toBeUndefined();
  });

  it("falls back to the message ts as the thread anchor", () => {
    const n = buildSlackCompletionNotification({
      run: coords({ slack_thread_ts: null }),
      automationName: "Triage",
      success: true,
    });
    expect(n?.threadTs).toBe("1700000000.000100");
  });

  it("includes a truncated error summary on failure", () => {
    const longError = "x".repeat(5000);
    const n = buildSlackCompletionNotification({
      run: coords(),
      automationName: "Triage",
      success: false,
      error: longError,
    });
    expect(n?.success).toBe(false);
    expect(n?.summary?.length).toBe(1500);
  });
});

describe("buildSlackSkipNotification", () => {
  it("returns null when the actor is unknown", () => {
    expect(buildSlackSkipNotification({ channelId: "C1", ts: "1700000000.000100" })).toBeNull();
  });

  it("targets the actor and anchors to the thread ts when present", () => {
    expect(
      buildSlackSkipNotification({
        channelId: "C1",
        actorUserId: "U9",
        threadTs: "1699999999.000001",
        ts: "1700000000.000100",
      })
    ).toEqual({ channel: "C1", user: "U9", threadTs: "1699999999.000001" });
  });

  it("falls back to the message ts as the thread anchor", () => {
    expect(
      buildSlackSkipNotification({ channelId: "C1", actorUserId: "U9", ts: "1700000000.000100" })
    ).toEqual({ channel: "C1", user: "U9", threadTs: "1700000000.000100" });
  });
});
