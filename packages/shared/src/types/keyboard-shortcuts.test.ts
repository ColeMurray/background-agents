import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  GLOBAL_KEYBOARD_SHORTCUT_ACTIONS,
  KEYBOARD_SHORTCUT_ACTIONS,
  keyboardShortcutBindingKey,
  keyboardShortcutPreferencesSchema,
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

  it("allows Enter with or without Shift for sending prompts", () => {
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "send-prompt": { code: "Enter", primary: false, alt: false, shift: false },
      }).success
    ).toBe(true);
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "send-prompt": { code: "Enter", primary: false, alt: false, shift: true },
      }).success
    ).toBe(true);
  });

  it("requires primary or alt for other actions and a non-modifier key", () => {
    expect(
      keyboardShortcutPreferencesSchema.safeParse({
        ...DEFAULT_KEYBOARD_SHORTCUTS,
        "open-command-menu": { code: "Enter", primary: false, alt: false, shift: false },
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

  it("derives action lists and binding identity from the canonical definitions", () => {
    expect(KEYBOARD_SHORTCUT_ACTIONS).toEqual(Object.keys(DEFAULT_KEYBOARD_SHORTCUTS));
    expect(GLOBAL_KEYBOARD_SHORTCUT_ACTIONS).toEqual([
      "open-command-menu",
      "new-session",
      "toggle-sidebar",
    ]);
    expect(keyboardShortcutBindingKey(DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"])).toBe(
      "true:false:false:Enter"
    );
  });
});
