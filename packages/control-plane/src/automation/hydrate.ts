import type { Automation } from "@open-inspect/shared/types/automations";
import { AutomationStore, toAutomation, type AutomationRow } from "../db/automation-store";
import { AutomationModelProviderAuthStore } from "../db/automation-model-provider-auth";
import type { SqlDatabase } from "../db/sql-database";

export async function hydrateAutomation(db: SqlDatabase, row: AutomationRow): Promise<Automation> {
  const store = new AutomationStore(db);
  const providerAuthStore = new AutomationModelProviderAuthStore(db);
  const [repositories, environments, providerAuth] = await Promise.all([
    store.getRepositoriesForAutomation(row.id),
    store.getEnvironmentsForAutomation(row.id),
    providerAuthStore.list(row.id),
  ]);
  return toAutomation(row, repositories, environments, providerAuth);
}
