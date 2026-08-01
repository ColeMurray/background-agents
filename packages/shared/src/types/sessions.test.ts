import { describe, expect, it } from "vitest";
import {
  sessionTerminalOutcomeReadActionSchema,
  sessionTerminalOutcomeReadResultSchema,
} from "./sessions";

describe("session terminal-outcome read contracts", () => {
  it("accepts only explicit exact and latest read actions", () => {
    expect(
      sessionTerminalOutcomeReadActionSchema.safeParse({
        action: "mark_terminal_outcome_read",
        terminalOutcomeMessageId: "message-1",
      }).success
    ).toBe(true);
    expect(
      sessionTerminalOutcomeReadActionSchema.safeParse({
        action: "mark_latest_terminal_outcome_read",
      }).success
    ).toBe(true);
    expect(
      sessionTerminalOutcomeReadActionSchema.safeParse({
        action: "mark_latest_terminal_outcome_read",
        terminalOutcomeMessageId: "message-1",
      }).success
    ).toBe(false);
  });

  it("rejects unread state without a terminal-outcome message", () => {
    expect(
      sessionTerminalOutcomeReadResultSchema.safeParse({
        sessionId: "session-1",
        outcome: "no_terminal_outcome",
        hasUnreadTerminalOutcome: true,
        latestTerminalOutcomeMessageId: null,
      }).success
    ).toBe(false);
  });
});
