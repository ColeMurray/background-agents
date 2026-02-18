import { describe, expect, it } from "vitest";
import { matchGlobalShortcut, shouldIgnoreGlobalShortcut } from "./keyboard-shortcuts";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    ...overrides,
  } as KeyboardEvent;
}

describe("matchGlobalShortcut", () => {
  it("matches Cmd/Ctrl+K for new session", () => {
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "k" }))).toBe("new-session");
    expect(matchGlobalShortcut(createKeyEvent({ ctrlKey: true, key: "K" }))).toBe("new-session");
  });

  it("matches Cmd/Ctrl+/ for sidebar toggle", () => {
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "Slash" }))).toBe(
      "toggle-sidebar"
    );
    expect(matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "Slash" }))).toBe(
      "toggle-sidebar"
    );
  });

  it("does not match when modifiers are invalid", () => {
    expect(matchGlobalShortcut(createKeyEvent({ key: "k" }))).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "k", shiftKey: true }))
    ).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "Slash", altKey: true }))
    ).toBeNull();
  });
});

describe("shouldIgnoreGlobalShortcut", () => {
  it("ignores prevented and composing events", () => {
    expect(shouldIgnoreGlobalShortcut(createKeyEvent({ defaultPrevented: true }))).toBe(true);
    expect(shouldIgnoreGlobalShortcut(createKeyEvent({ isComposing: true }))).toBe(true);
  });
});
