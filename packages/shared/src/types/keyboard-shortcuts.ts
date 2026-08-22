import { z } from "zod";

export const KEYBOARD_SHORTCUT_ACTIONS = [
  "send-prompt",
  "open-command-menu",
  "new-session",
  "toggle-sidebar",
] as const;

export type KeyboardShortcutAction = (typeof KEYBOARD_SHORTCUT_ACTIONS)[number];

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

export const keyboardShortcutBindingSchema = z
  .strictObject({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/),
    primary: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  })
  .refine(({ primary, alt }) => primary || alt, {
    message: "A primary or Alt modifier is required",
  })
  .refine(({ code }) => !MODIFIER_CODES.has(code), {
    message: "A non-modifier key is required",
  });

export type KeyboardShortcutBinding = z.infer<typeof keyboardShortcutBindingSchema>;

const keyboardShortcutPreferencesObjectSchema = z.strictObject({
  "send-prompt": keyboardShortcutBindingSchema,
  "open-command-menu": keyboardShortcutBindingSchema,
  "new-session": keyboardShortcutBindingSchema,
  "toggle-sidebar": keyboardShortcutBindingSchema,
});

export const storedKeyboardShortcutPreferencesSchema =
  keyboardShortcutPreferencesObjectSchema.partial();

export const keyboardShortcutPreferencesSchema =
  keyboardShortcutPreferencesObjectSchema.superRefine((shortcuts, ctx) => {
    const seen = new Set<string>();
    for (const action of KEYBOARD_SHORTCUT_ACTIONS) {
      const binding = shortcuts[action];
      const canonical = `${binding.primary}:${binding.alt}:${binding.shift}:${binding.code}`;
      if (seen.has(canonical)) {
        ctx.addIssue({
          code: "custom",
          path: [action],
          message: "Keyboard shortcuts must be unique",
        });
      }
      seen.add(canonical);
    }
  });

export type KeyboardShortcutPreferences = z.infer<typeof keyboardShortcutPreferencesSchema>;

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutPreferences = {
  "send-prompt": { code: "Enter", primary: true, alt: false, shift: false },
  "open-command-menu": { code: "KeyK", primary: true, alt: false, shift: false },
  "new-session": { code: "KeyO", primary: true, alt: false, shift: true },
  "toggle-sidebar": { code: "Slash", primary: true, alt: false, shift: false },
};

export const keyboardShortcutPreferencesResponseSchema = z.strictObject({
  shortcuts: keyboardShortcutPreferencesSchema,
});

export const updateKeyboardShortcutPreferencesSchema = keyboardShortcutPreferencesResponseSchema;
