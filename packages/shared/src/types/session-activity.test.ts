import { describe, expect, it } from "vitest";

import { isSessionInactive, isSessionPromptable, isTurnSettled } from "./session-activity";
import { sessionStatusSchema, type SessionStatus } from "./sessions";

const ALL_STATUSES = sessionStatusSchema.options;

describe("isSessionInactive", () => {
  // Asked wherever a session must not be counted as live work: child
  // accounting, cancellability, and the sidebar's has-a-running-child check.
  // Those three sites each carried their own copy of this set before it moved
  // here, and one of the copies was an untyped Set<string> in another package.
  it.each([
    ["created", false],
    ["active", false],
    ["completed", true],
    ["failed", true],
    ["archived", true],
    ["cancelled", true],
  ] as const)("treats %s as inactive=%s", (status, expected) => {
    expect(isSessionInactive(status)).toBe(expected);
  });

  it("classifies every SessionStatus", () => {
    for (const status of ALL_STATUSES) {
      expect(typeof isSessionInactive(status)).toBe("boolean");
    }
  });
});

describe("isTurnSettled", () => {
  // Deliberately NOT the same question as isSessionInactive: this one asks
  // whether a turn just finished, so metrics can be synced. `archived` is
  // excluded because archiving is a filing action, not the end of a turn — no
  // execution completed, so there are no new metrics to write.
  it.each([
    ["created", false],
    ["active", false],
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
    ["archived", false],
  ] as const)("treats %s as settled=%s", (status, expected) => {
    expect(isTurnSettled(status)).toBe(expected);
  });

  it("differs from isSessionInactive on archived, and only on archived", () => {
    const divergent = ALL_STATUSES.filter(
      (status: SessionStatus) => isTurnSettled(status) !== isSessionInactive(status)
    );
    expect(divergent).toEqual(["archived"]);
  });
});

describe("isSessionPromptable", () => {
  it.each([
    ["created", true],
    ["active", true],
    ["completed", true],
    ["failed", true],
    ["archived", false],
    ["cancelled", false],
  ] as const)("treats %s as promptable=%s", (status, expected) => {
    expect(isSessionPromptable(status)).toBe(expected);
  });
});
