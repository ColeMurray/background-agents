import { describe, expect, it } from "vitest";
import { shouldAttemptMarkTerminalOutcomeRead } from "./terminal-outcome-read-observer";

const readyState = {
  enabled: true,
  attemptsComplete: false,
  requestInFlight: false,
  attemptCount: 0,
  intersecting: true,
  documentVisible: true,
  documentFocused: true,
};

describe("shouldAttemptMarkTerminalOutcomeRead", () => {
  it("attempts only when every visibility and lifecycle condition is satisfied", () => {
    expect(shouldAttemptMarkTerminalOutcomeRead(readyState)).toBe(true);
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, enabled: false })).toBe(false);
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, intersecting: false })).toBe(
      false
    );
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, documentFocused: false })).toBe(
      false
    );
  });

  it("stops completed, in-flight, and exhausted attempts", () => {
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, attemptsComplete: true })).toBe(
      false
    );
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, requestInFlight: true })).toBe(
      false
    );
    expect(shouldAttemptMarkTerminalOutcomeRead({ ...readyState, attemptCount: 4 })).toBe(false);
  });
});
