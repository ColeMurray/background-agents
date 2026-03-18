// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { matchGlobalShortcut, shouldIgnoreGlobalShortcutForAction } from "./keyboard-shortcuts";

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
  it("matches Cmd/Ctrl+K for command menu", () => {
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "k" }))).toBe(
      "open-command-menu"
    );
    expect(matchGlobalShortcut(createKeyEvent({ ctrlKey: true, key: "K" }))).toBe(
      "open-command-menu"
    );
  });

  it("matches Cmd/Ctrl+Shift+O for new session", () => {
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "o", shiftKey: true }))).toBe(
      "new-session"
    );
    expect(matchGlobalShortcut(createKeyEvent({ ctrlKey: true, key: "O", shiftKey: true }))).toBe(
      "new-session"
    );
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
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "o" }))).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ metaKey: true, key: "k", shiftKey: true }))
    ).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "Slash", altKey: true }))
    ).toBeNull();
  });
});

describe("shouldIgnoreGlobalShortcutForAction", () => {
  it("ignores prevented/composing and allows Cmd/Ctrl+K in editable fields", () => {
    expect(
      shouldIgnoreGlobalShortcutForAction(createKeyEvent({ defaultPrevented: true }), "new-session")
    ).toBe(true);
    expect(
      shouldIgnoreGlobalShortcutForAction(createKeyEvent({ isComposing: true }), "new-session")
    ).toBe(true);

    const input = document.createElement("input");
    const event = createKeyEvent({ target: input });

    expect(shouldIgnoreGlobalShortcutForAction(event, "open-command-menu")).toBe(false);
    expect(shouldIgnoreGlobalShortcutForAction(event, "new-session")).toBe(true);
  });
});
