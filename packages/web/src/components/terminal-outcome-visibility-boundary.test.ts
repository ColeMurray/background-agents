import { describe, expect, it } from "vitest";
import { shouldAttemptTerminalAcknowledgement } from "./terminal-outcome-visibility-boundary";

const readyState = {
  enabled: true,
  acknowledged: false,
  requestInFlight: false,
  attemptCount: 0,
  intersecting: true,
  documentVisible: true,
  documentFocused: true,
};

describe("shouldAttemptTerminalAcknowledgement", () => {
  it("attempts only when every visibility and lifecycle condition is satisfied", () => {
    expect(shouldAttemptTerminalAcknowledgement(readyState)).toBe(true);
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, enabled: false })).toBe(false);
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, intersecting: false })).toBe(
      false
    );
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, documentFocused: false })).toBe(
      false
    );
  });

  it("stops acknowledged, in-flight, and exhausted attempts", () => {
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, acknowledged: true })).toBe(false);
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, requestInFlight: true })).toBe(
      false
    );
    expect(shouldAttemptTerminalAcknowledgement({ ...readyState, attemptCount: 4 })).toBe(false);
  });
});
