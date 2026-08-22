import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_ACTIONS,
  keyboardShortcutPreferencesSchema,
  storedKeyboardShortcutPreferencesSchema,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import type { SqlDatabase } from "./sql-database";

export class KeyboardShortcutPreferencesStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(userId: string): Promise<KeyboardShortcutPreferences> {
    const row = await this.db
      .prepare("SELECT shortcuts FROM keyboard_shortcut_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ shortcuts: string }>();
    if (!row) return DEFAULT_KEYBOARD_SHORTCUTS;
    const stored = storedKeyboardShortcutPreferencesSchema.parse(JSON.parse(row.shortcuts));
    const merged = keyboardShortcutPreferencesSchema.safeParse({
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      ...stored,
    });
    if (merged.success) return merged.data;

    // A future default may collide with older overrides. Select the largest
    // compatible override set as a group so coordinated swaps remain intact.
    const overrides = KEYBOARD_SHORTCUT_ACTIONS.flatMap((action) =>
      stored[action] ? ([[action, stored[action]]] as const) : []
    );
    for (let size = overrides.length; size >= 0; size -= 1) {
      for (let mask = 0; mask < 1 << overrides.length; mask += 1) {
        const selected = overrides.filter((_, index) => mask & (1 << index));
        if (selected.length !== size) continue;
        const candidate = keyboardShortcutPreferencesSchema.safeParse({
          ...DEFAULT_KEYBOARD_SHORTCUTS,
          ...Object.fromEntries(selected),
        });
        if (candidate.success) return candidate.data;
      }
    }
    return DEFAULT_KEYBOARD_SHORTCUTS;
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
      .bind(userId, JSON.stringify(validated), Date.now())
      .run();
    return validated;
  }
}
