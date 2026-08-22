import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_PREFERENCES_VERSION,
  keyboardShortcutPreferencesSchema,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

const storedKeyboardShortcutPreferencesSchema = z.strictObject({
  version: z.literal(KEYBOARD_SHORTCUT_PREFERENCES_VERSION),
  shortcuts: keyboardShortcutPreferencesSchema,
});

export class KeyboardShortcutPreferencesStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(userId: string): Promise<KeyboardShortcutPreferences> {
    const row = await this.db
      .prepare("SELECT shortcuts FROM keyboard_shortcut_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ shortcuts: string }>();
    if (!row) return DEFAULT_KEYBOARD_SHORTCUTS;
    return storedKeyboardShortcutPreferencesSchema.parse(JSON.parse(row.shortcuts)).shortcuts;
  }

  async set(
    userId: string,
    shortcuts: KeyboardShortcutPreferences
  ): Promise<KeyboardShortcutPreferences> {
    const validated = keyboardShortcutPreferencesSchema.parse(shortcuts);
    await this.db
      .prepare(
        `INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET shortcuts = excluded.shortcuts, updated_at = excluded.updated_at`
      )
      .bind(
        userId,
        JSON.stringify({
          version: KEYBOARD_SHORTCUT_PREFERENCES_VERSION,
          shortcuts: validated,
        }),
        Date.now()
      )
      .run();
    return validated;
  }
}
