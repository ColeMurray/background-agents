import { describe, expect, it } from "vitest";

import { SESSION_TRANSITIONS, isLegalSessionTransition } from "./session-activity";
import { sessionStatusSchema, type SessionStatus } from "./sessions";

const ALL_STATUSES = sessionStatusSchema.options;

describe("SESSION_TRANSITIONS", () => {
  it("covers every status", () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("only ever targets real statuses", () => {
    for (const targets of Object.values(SESSION_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it("never lists a status as a transition to itself", () => {
    // `transition()` short-circuits when the status is unchanged, so a
    // same-status entry would be dead weight that hides a real question.
    for (const [from, targets] of Object.entries(SESSION_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });
});

describe("isLegalSessionTransition", () => {
  it("always permits a no-op", () => {
    for (const status of ALL_STATUSES as readonly SessionStatus[]) {
      expect(isLegalSessionTransition(status, status)).toBe(true);
    }
  });

  // Each of these is a path the code actually takes. A table that rejects one
  // is worse than no table: an earlier draft of this work forbade
  // created -> completed, which the abandoned-draft repair performs and an
  // integration test asserts, so asserting it would have broken the sweep on
  // exactly the rows it exists to unstick.
  it.each([
    ["created", "active", "a first prompt is enqueued"],
    ["created", "completed", "expire-draft settles a draft whose messages finished"],
    ["created", "failed", "expire-draft settles a draft whose last message failed"],
    ["created", "archived", "the abandoned-draft sweep reclaims it"],
    ["created", "cancelled", "the session is cancelled before it ever ran"],
    ["active", "completed", "an execution finished successfully"],
    ["active", "failed", "an execution failed"],
    ["active", "cancelled", "the session is cancelled mid-flight"],
    ["active", "archived", "archived with no queued work"],
    ["active", "created", "the only pending prompt was cancelled and deleted"],
    ["completed", "active", "a follow-up prompt arrives"],
    ["completed", "archived", "an idle session is filed away"],
    ["failed", "active", "a retry prompt arrives"],
    ["failed", "archived", "a failed session is filed away"],
    ["archived", "active", "unarchive settles to queued work"],
    ["archived", "completed", "unarchive settles to finished messages"],
    ["archived", "failed", "unarchive settles to a failed last turn"],
    ["archived", "created", "unarchive settles an empty session back to draft"],
  ] as const)("permits %s -> %s because %s", (from, to) => {
    expect(isLegalSessionTransition(from, to)).toBe(true);
  });

  // `cancelled` is absorbing by design, agreed on independently in four places:
  // isPromptableSessionStatus, the archive guard, the unarchive guard, and the
  // web composer. Users stop a prompt; they do not cancel a session.
  it.each(ALL_STATUSES.filter((status) => status !== "cancelled"))(
    "forbids cancelled -> %s",
    (to) => {
      expect(isLegalSessionTransition("cancelled", to)).toBe(false);
    }
  );

  it.each([
    ["completed", "failed"],
    ["failed", "completed"],
    ["completed", "cancelled"],
    ["failed", "cancelled"],
    ["archived", "cancelled"],
  ] as const)("forbids %s -> %s", (from, to) => {
    expect(isLegalSessionTransition(from, to)).toBe(false);
  });
});
