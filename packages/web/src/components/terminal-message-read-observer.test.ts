import { describe, expect, it } from "vitest";
import { shouldAttemptMarkMessageRead } from "./terminal-message-read-observer";

const readyState = {
  enabled: true,
  attemptsComplete: false,
  requestInFlight: false,
  attemptCount: 0,
  intersecting: true,
  documentVisible: true,
  documentFocused: true,
};

describe("shouldAttemptMarkMessageRead", () => {
  it("attempts only when every visibility and lifecycle condition is satisfied", () => {
    expect(shouldAttemptMarkMessageRead(readyState)).toBe(true);
    expect(shouldAttemptMarkMessageRead({ ...readyState, enabled: false })).toBe(false);
    expect(shouldAttemptMarkMessageRead({ ...readyState, intersecting: false })).toBe(false);
    expect(shouldAttemptMarkMessageRead({ ...readyState, documentFocused: false })).toBe(false);
  });

  it("stops completed, in-flight, and exhausted attempts", () => {
    expect(shouldAttemptMarkMessageRead({ ...readyState, attemptsComplete: true })).toBe(false);
    expect(shouldAttemptMarkMessageRead({ ...readyState, requestInFlight: true })).toBe(false);
    expect(shouldAttemptMarkMessageRead({ ...readyState, attemptCount: 4 })).toBe(false);
  });
});
