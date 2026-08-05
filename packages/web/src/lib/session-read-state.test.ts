import { describe, expect, it } from "vitest";
import { classifySessionReadAttempt } from "./session-read-state";

describe("classifySessionReadAttempt", () => {
  it.each(["marked_read", "already_read"] as const)("completes after a %s result", (outcome) => {
    expect(
      classifySessionReadAttempt({
        sessionId: "session-1",
        outcome,
        unread: false,
        latestMessageId: "message-1",
      })
    ).toBe("complete");
  });

  it.each(["not_latest", "no_terminal_message"] as const)(
    "retries after a %s result because projection may still be pending",
    (outcome) => {
      const result =
        outcome === "no_terminal_message"
          ? ({
              sessionId: "session-1",
              outcome,
              unread: false,
              latestMessageId: null,
            } as const)
          : ({
              sessionId: "session-1",
              outcome,
              unread: true,
              latestMessageId: "message-previous",
            } as const);
      expect(classifySessionReadAttempt(result)).toBe("retry");
    }
  );
});
