import { z } from "zod";

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
  .refine(({ code, primary, alt }) => primary || alt || code === "Enter", {
    message: "A primary or Alt modifier is required unless the key is Enter",
  })
  .refine(({ code }) => !MODIFIER_CODES.has(code), {
    message: "A non-modifier key is required",
  });

export type KeyboardShortcutBinding = z.infer<typeof keyboardShortcutBindingSchema>;

export const KEYBOARD_SHORTCUT_PREFERENCES_VERSION = 1;

export const KEYBOARD_SHORTCUT_DEFINITIONS = {
  "send-prompt": {
    defaultBinding: { code: "Enter", primary: true, alt: false, shift: false },
    global: false,
  },
  "open-command-menu": {
    defaultBinding: { code: "KeyK", primary: true, alt: false, shift: false },
    global: true,
  },
  "new-session": {
    defaultBinding: { code: "KeyO", primary: true, alt: false, shift: true },
    global: true,
  },
  "toggle-sidebar": {
    defaultBinding: { code: "Slash", primary: true, alt: false, shift: false },
    global: true,
  },
} as const satisfies Record<string, { defaultBinding: KeyboardShortcutBinding; global: boolean }>;

export type KeyboardShortcutAction = keyof typeof KEYBOARD_SHORTCUT_DEFINITIONS;
export type GlobalKeyboardShortcutAction = {
  [Action in KeyboardShortcutAction]: (typeof KEYBOARD_SHORTCUT_DEFINITIONS)[Action]["global"] extends true
    ? Action
    : never;
}[KeyboardShortcutAction];
export type KeyboardShortcutPreferences = Record<KeyboardShortcutAction, KeyboardShortcutBinding>;

export function isKeyboardShortcutBindingAllowed(
  action: KeyboardShortcutAction,
  binding: KeyboardShortcutBinding
): boolean {
  return action === "send-prompt" || binding.primary || binding.alt;
}

export const KEYBOARD_SHORTCUT_ACTIONS = Object.keys(
  KEYBOARD_SHORTCUT_DEFINITIONS
) as KeyboardShortcutAction[];
export const GLOBAL_KEYBOARD_SHORTCUT_ACTIONS = KEYBOARD_SHORTCUT_ACTIONS.filter(
  (action): action is GlobalKeyboardShortcutAction => KEYBOARD_SHORTCUT_DEFINITIONS[action].global
);

export const DEFAULT_KEYBOARD_SHORTCUTS = Object.fromEntries(
  KEYBOARD_SHORTCUT_ACTIONS.map((action) => [
    action,
    KEYBOARD_SHORTCUT_DEFINITIONS[action].defaultBinding,
  ])
) as KeyboardShortcutPreferences;

const keyboardShortcutPreferencesObjectSchema = z.strictObject(
  Object.fromEntries(
    KEYBOARD_SHORTCUT_ACTIONS.map((action) => [action, keyboardShortcutBindingSchema])
  ) as Record<KeyboardShortcutAction, typeof keyboardShortcutBindingSchema>
);

export function keyboardShortcutBindingKey(binding: KeyboardShortcutBinding): string {
  return `${binding.primary}:${binding.alt}:${binding.shift}:${binding.code}`;
}

export const keyboardShortcutPreferencesSchema: z.ZodType<KeyboardShortcutPreferences> =
  keyboardShortcutPreferencesObjectSchema.superRefine((shortcuts, ctx) => {
    const seen = new Set<string>();
    for (const action of KEYBOARD_SHORTCUT_ACTIONS) {
      const binding = shortcuts[action];
      if (!isKeyboardShortcutBindingAllowed(action, binding)) {
        ctx.addIssue({
          code: "custom",
          path: [action],
          message: "A primary or Alt modifier is required for this action",
        });
      }
      const canonical = keyboardShortcutBindingKey(binding);
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

export const keyboardShortcutPreferencesPayloadSchema = z.strictObject({
  shortcuts: keyboardShortcutPreferencesSchema,
});
