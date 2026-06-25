import { describe, it, expect } from "vitest";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  type SlackRunMetadata,
} from "./slack-completion";

function meta(overrides?: Partial<SlackRunMetadata>): SlackRunMetadata {
  return {
    channel: "C1",
    messageTs: "1700000000.000100",
    ...overrides,
  };
}

describe("buildSlackCompletionNotification", () => {
  it("returns null for a non-slack run (no metadata)", () => {
    expect(buildSlackCompletionNotification(null)).toBeNull();
  });

  it("returns null when there is no triggering message to clear", () => {
    expect(buildSlackCompletionNotification(meta({ messageTs: "" }))).toBeNull();
  });

  it("targets the triggering message's eyes reaction", () => {
    expect(buildSlackCompletionNotification(meta())).toEqual({
      channel: "C1",
      reactionMessageTs: "1700000000.000100",
    });
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
