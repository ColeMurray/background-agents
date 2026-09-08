import { useMemo } from "react";
import useSWR from "swr";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_ACTIONS,
  keyboardShortcutPreferencesPayloadSchema,
  type KeyboardShortcutAction,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { formatShortcut } from "@/lib/keyboard-shortcuts";

export const KEYBOARD_SHORTCUTS_KEY = "/api/keyboard-shortcuts";

async function fetchKeyboardShortcuts() {
  const response = await browserApiFetch(KEYBOARD_SHORTCUTS_KEY);
  if (!response.ok) throw new Error("Failed to load keyboard shortcuts");
  return keyboardShortcutPreferencesPayloadSchema.parse(await response.json());
}

export function useKeyboardShortcuts() {
  const { data, error, isLoading, mutate } = useSWR(KEYBOARD_SHORTCUTS_KEY, fetchKeyboardShortcuts);
  const parsed = useMemo(() => keyboardShortcutPreferencesPayloadSchema.safeParse(data), [data]);
  const shortcuts = parsed.success ? parsed.data.shortcuts : DEFAULT_KEYBOARD_SHORTCUTS;
  const labels = useMemo(
    () =>
      Object.fromEntries(
        KEYBOARD_SHORTCUT_ACTIONS.map((action) => [action, formatShortcut(shortcuts[action])])
      ) as Record<KeyboardShortcutAction, string>,
    [shortcuts]
  );

  async function save(next: KeyboardShortcutPreferences): Promise<void> {
    const response = await browserApiFetch(KEYBOARD_SHORTCUTS_KEY, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcuts: next }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Failed to save keyboard shortcuts";
      throw new Error(message);
    }
    const saved = keyboardShortcutPreferencesPayloadSchema.parse(body);
    await mutate(saved, { revalidate: false });
  }

  return { shortcuts, labels, loading: isLoading, error, save };
}
