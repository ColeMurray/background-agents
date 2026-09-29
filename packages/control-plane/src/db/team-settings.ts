import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

export const teamSettingsSchema = z.strictObject({ requireTeamOnCreate: z.boolean() });
export type TeamSettings = z.infer<typeof teamSettingsSchema>;

export class TeamSettingsStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(): Promise<TeamSettings> {
    const row = await this.db
      .prepare("SELECT settings FROM integration_settings WHERE integration_id = ?")
      .bind("teams")
      .first<{ settings: string }>();
    return row
      ? teamSettingsSchema.parse(JSON.parse(row.settings))
      : { requireTeamOnCreate: false };
  }

  async set(settings: TeamSettings): Promise<void> {
    const parsed = teamSettingsSchema.parse(settings);
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO integration_settings (integration_id, settings, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (integration_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
      )
      .bind("teams", JSON.stringify(parsed), now, now)
      .run();
  }
}
