// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import {
  captureShortcut,
  findDuplicateShortcutActions,
  formatShortcut,
  matchGlobalShortcut,
  matchesShortcut,
  shouldIgnoreGlobalShortcutForAction,
} from "./keyboard-shortcuts";

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
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "KeyK" }))).toBe(
      "open-command-menu"
    );
    expect(matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "KeyK" }))).toBe(
      "open-command-menu"
    );
  });

  it("matches Cmd/Ctrl+Shift+O for new session", () => {
    expect(
      matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "KeyO", shiftKey: true }))
    ).toBe("new-session");
    expect(
      matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "KeyO", shiftKey: true }))
    ).toBe("new-session");
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
    expect(matchGlobalShortcut(createKeyEvent({ code: "KeyK" }))).toBeNull();
    expect(matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "KeyO" }))).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "KeyK", shiftKey: true }))
    ).toBeNull();
    expect(
      matchGlobalShortcut(createKeyEvent({ ctrlKey: true, code: "Slash", altKey: true }))
    ).toBeNull();
  });

  it("matches configured bindings", () => {
    const shortcuts = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "open-command-menu": { code: "KeyP", primary: false, alt: true, shift: true },
    };
    expect(
      matchGlobalShortcut(createKeyEvent({ code: "KeyP", altKey: true, shiftKey: true }), shortcuts)
    ).toBe("open-command-menu");
    expect(
      matchGlobalShortcut(createKeyEvent({ metaKey: true, code: "KeyK" }), shortcuts)
    ).toBeNull();
  });
});

describe("shortcut capture and display", () => {
  it("captures Meta and Control as the portable primary modifier", () => {
    expect(
      captureShortcut(
        createKeyEvent({ code: "KeyJ", metaKey: true, shiftKey: true }),
        "open-command-menu"
      )
    ).toEqual({
      code: "KeyJ",
      primary: true,
      alt: false,
      shift: true,
    });
    expect(
      captureShortcut(createKeyEvent({ code: "KeyJ", ctrlKey: true }), "open-command-menu")
    ).toEqual({
      code: "KeyJ",
      primary: true,
      alt: false,
      shift: false,
    });
  });

  it("ignores modifiers and combinations without primary or Alt", () => {
    expect(
      captureShortcut(createKeyEvent({ code: "ShiftLeft", shiftKey: true }), "open-command-menu")
    ).toBeNull();
    expect(
      captureShortcut(createKeyEvent({ code: "KeyJ", shiftKey: true }), "open-command-menu")
    ).toBeNull();
  });

  it("captures Enter with or without Shift only for sending prompts", () => {
    expect(captureShortcut(createKeyEvent({ code: "Enter" }), "send-prompt")).toEqual({
      code: "Enter",
      primary: false,
      alt: false,
      shift: false,
    });
    expect(
      captureShortcut(createKeyEvent({ code: "Enter", shiftKey: true }), "send-prompt")
    ).toEqual({ code: "Enter", primary: false, alt: false, shift: true });
    expect(captureShortcut(createKeyEvent({ code: "Enter" }), "open-command-menu")).toBeNull();
  });

  it("formats common physical key codes", () => {
    expect(formatShortcut(DEFAULT_KEYBOARD_SHORTCUTS["toggle-sidebar"])).toBe("Cmd/Ctrl+/");
    expect(formatShortcut({ code: "Space", primary: false, alt: true, shift: true })).toBe(
      "Alt+Shift+Space"
    );
  });

  it("matches send bindings and identifies both sides of a collision", () => {
    expect(
      matchesShortcut(
        createKeyEvent({ code: "Enter", ctrlKey: true }),
        DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"]
      )
    ).toBe(true);
    const duplicates = findDuplicateShortcutActions({
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "new-session": DEFAULT_KEYBOARD_SHORTCUTS["open-command-menu"],
    });
    expect(duplicates).toEqual(new Set(["open-command-menu", "new-session"]));
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
