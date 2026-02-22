import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../theme";

export class UserPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserPreferencesValidationError";
  }
}

export class UserPreferencesStore {
  constructor(private readonly db: D1Database) {}

  async getTheme(userId: string): Promise<ThemeId | null> {
    const row = await this.db
      .prepare("SELECT theme FROM user_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ theme: string }>();

    if (!row) return null;
    if (!isThemeId(row.theme)) return DEFAULT_THEME_ID;
    return row.theme;
  }

  async setTheme(userId: string, theme: string): Promise<ThemeId> {
    if (!isThemeId(theme)) {
      throw new UserPreferencesValidationError(`Invalid theme: ${theme}`);
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO user_preferences (user_id, theme, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           theme = excluded.theme,
           updated_at = excluded.updated_at`
      )
      .bind(userId, theme, now, now)
      .run();

    return theme;
  }
}
