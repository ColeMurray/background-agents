import { describe, expect, it } from "vitest";
import { classifyTerminalOutcomeReadAttempt } from "./session-terminal-outcome-read-state";

describe("classifyTerminalOutcomeReadAttempt", () => {
  it.each(["marked_read", "already_read"] as const)("completes after a %s result", (outcome) => {
    expect(
      classifyTerminalOutcomeReadAttempt({
        sessionId: "session-1",
        outcome,
        hasUnreadTerminalOutcome: false,
        latestTerminalOutcomeMessageId: "message-1",
      })
    ).toBe("complete");
  });

  it.each(["not_latest", "no_terminal_outcome"] as const)(
    "retries after a %s result because projection may still be pending",
    (outcome) => {
      const result =
        outcome === "no_terminal_outcome"
          ? ({
              sessionId: "session-1",
              outcome,
              hasUnreadTerminalOutcome: false,
              latestTerminalOutcomeMessageId: null,
            } as const)
          : ({
              sessionId: "session-1",
              outcome,
              hasUnreadTerminalOutcome: true,
              latestTerminalOutcomeMessageId: "message-previous",
            } as const);
      expect(classifyTerminalOutcomeReadAttempt(result)).toBe("retry");
    }
  );
});
