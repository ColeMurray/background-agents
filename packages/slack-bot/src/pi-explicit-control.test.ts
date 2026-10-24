import { describe, expect, it } from "vitest";
import { parseSlackPiExplicitControl, slackPiControlRequestId } from "./pi-explicit-control";

describe("parseSlackPiExplicitControl", () => {
  it("accepts only the explicit follow-up command", () => {
    expect(parseSlackPiExplicitControl("follow up now: run the focused test")).toEqual({
      action: "follow_up",
      content: "run the focused test",
    });
    expect(parseSlackPiExplicitControl("FOLLOW UP NOW: run the focused test")).toEqual({
      action: "follow_up",
      content: "run the focused test",
    });
  });

  it.each([
    "please steer toward tests",
    "follow up when done",
    "steer:",
    "steer: avoid changing the API",
    "follow up now",
    "ordinary thread reply",
  ])("keeps ordinary text on the queued path: %s", (text) => {
    expect(parseSlackPiExplicitControl(text)).toBeNull();
  });

  it("derives a stable bounded idempotency key from the Slack event", async () => {
    const first = await slackPiControlRequestId("event-1");
    expect(await slackPiControlRequestId("event-1")).toBe(first);
    expect(first).toMatch(/^slack-control:[0-9a-f]{64}$/);
  });
});
