import { describe, it, expect } from "vitest";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  type SlackRunMetadata,
  type SlackCompletionContext,
} from "./slack-completion";

function meta(overrides?: Partial<SlackRunMetadata>): SlackRunMetadata {
  return {
    channel: "C1",
    messageTs: "1700000000.000100",
    ...overrides,
  };
}

function ctx(overrides?: Partial<SlackCompletionContext>): SlackCompletionContext {
  return {
    sessionId: "sess-1",
    messageId: "msg-1",
    success: true,
    repoFullName: "acme/web",
    model: "anthropic/claude-sonnet-4-6",
    ...overrides,
  };
}

describe("buildSlackCompletionNotification", () => {
  it("returns null for a non-slack run (no metadata)", () => {
    expect(buildSlackCompletionNotification(null, ctx())).toBeNull();
  });

  it("returns null when there is no triggering message to anchor to", () => {
    expect(buildSlackCompletionNotification(meta({ messageTs: "" }), ctx())).toBeNull();
  });

  it("carries the run result plus the triggering message coordinates", () => {
    expect(buildSlackCompletionNotification(meta(), ctx({ error: undefined }))).toEqual({
      channel: "C1",
      reactionMessageTs: "1700000000.000100",
      sessionId: "sess-1",
      messageId: "msg-1",
      success: true,
      repoFullName: "acme/web",
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("includes the failure detail when the run errored", () => {
    const result = buildSlackCompletionNotification(meta(), ctx({ success: false, error: "boom" }));
    expect(result).toMatchObject({ success: false, error: "boom" });
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
