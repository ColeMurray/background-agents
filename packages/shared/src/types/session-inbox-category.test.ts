import { describe, expect, it } from "vitest";

import { deriveInboxCategory } from "./session-activity";
import { sessionStatusSchema, type SessionStatus } from "./sessions";

const ALL_STATUSES = sessionStatusSchema.options;

describe("deriveInboxCategory", () => {
  // The rule is a fold over a session tree, not a per-session map: a root's
  // category depends on every descendant. That is why this takes a collection.
  it("returns finished for an empty tree", () => {
    expect(deriveInboxCategory([])).toBe("finished");
  });

  it.each(ALL_STATUSES)("classifies a single unread %s session as needs_attention", (status) => {
    expect(deriveInboxCategory([{ status, unread: true }])).toBe("needs_attention");
  });

  it.each(ALL_STATUSES)("classifies a single read %s session by its status", (status) => {
    const expected = status === "active" ? "in_progress" : "finished";
    expect(deriveInboxCategory([{ status, unread: false }])).toBe(expected);
  });

  // MAX(unread) and MAX(status = 'active') are aggregates over the whole
  // group, so a single matching descendant decides the root's category.
  it("lifts needs_attention from any descendant", () => {
    expect(
      deriveInboxCategory([
        { status: "completed", unread: false },
        { status: "completed", unread: true },
        { status: "archived", unread: false },
      ])
    ).toBe("needs_attention");
  });

  it("lifts in_progress from any descendant when nothing is unread", () => {
    expect(
      deriveInboxCategory([
        { status: "completed", unread: false },
        { status: "active", unread: false },
        { status: "failed", unread: false },
      ])
    ).toBe("in_progress");
  });

  it("prefers needs_attention over in_progress", () => {
    expect(
      deriveInboxCategory([
        { status: "active", unread: false },
        { status: "completed", unread: true },
      ])
    ).toBe("needs_attention");
  });

  it("classifies every status/unread pair without throwing", () => {
    for (const status of ALL_STATUSES as readonly SessionStatus[]) {
      for (const unread of [true, false]) {
        expect(["needs_attention", "in_progress", "finished"]).toContain(
          deriveInboxCategory([{ status, unread }])
        );
      }
    }
  });
});
