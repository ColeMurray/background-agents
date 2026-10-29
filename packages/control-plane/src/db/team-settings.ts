import { teamSettingsSchema, type TeamSettings } from "@open-inspect/shared/types/teams";
import { IntegrationSettingsStore } from "./integration-settings";
import type { SqlDatabase } from "./sql-database";

export { teamSettingsSchema };

export class TeamSettingsStore {
  private readonly settings: IntegrationSettingsStore;

  constructor(db: SqlDatabase) {
    this.settings = new IntegrationSettingsStore(db);
  }

  async get(): Promise<TeamSettings> {
    return (await this.settings.getGlobal("teams"))?.defaults ?? { requireTeamOnCreate: false };
  }

  async set(settings: TeamSettings): Promise<void> {
    await this.settings.setGlobal("teams", { defaults: teamSettingsSchema.parse(settings) });
  }
}
