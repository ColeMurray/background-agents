import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  keyboardShortcutPreferencesSchema,
  storedKeyboardShortcutPreferencesSchema,
} from "./keyboard-shortcuts";

describe("keyboard shortcut preferences", () => {
  it("accepts the complete default shortcut set", () => {
    expect(keyboardShortcutPreferencesSchema.parse(DEFAULT_KEYBOARD_SHORTCUTS)).toEqual(
      DEFAULT_KEYBOARD_SHORTCUTS
    );
  });

  it("requires every action and rejects unknown actions", () => {
    const { "toggle-sidebar": _, ...incomplete } = DEFAULT_KEYBOARD_SHORTCUTS;
    expect(keyboardShortcutPreferencesSchema.safeParse(incomplete).success).toBe(false);
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        unknown: DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"],
      }).success
    ).toBe(false);
  });

  it("requires primary or alt and a non-modifier key", () => {
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "send-prompt": { code: "Enter", primary: false, alt: false, shift: true },
      }).success
    ).toBe(false);
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "send-prompt": { code: "ControlLeft", primary: true, alt: false, shift: false },
      }).success
    ).toBe(false);
  });

  it("rejects duplicate bindings", () => {
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "new-session": DEFAULT_KEYBOARD_SHORTCUTS["open-command-menu"],
      }).success
    ).toBe(false);
  });

  it("accepts stored records that predate newly added actions", () => {
    const { "toggle-sidebar": _, ...olderRecord } = DEFAULT_KEYBOARD_SHORTCUTS;
    expect(storedKeyboardShortcutPreferencesSchema.parse(olderRecord)).toEqual(olderRecord);
  });
});
