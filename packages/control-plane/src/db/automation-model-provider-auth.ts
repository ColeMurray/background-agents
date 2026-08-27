import {
  assertProviderAuthSelection,
  type ProviderAuthMode,
} from "../model-provider-accounts/provider-auth-contracts";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface AutomationModelProviderAuthRow {
  automation_id: string;
  provider: string;
  auth_mode: ProviderAuthMode;
  provider_account_id: string | null;
  created_at: number;
  updated_at: number;
}

export function toProviderSelections(
  rows: AutomationModelProviderAuthRow[]
): ModelProviderSelections {
  return Object.fromEntries(
    rows.map((row) => {
      assertProviderAuthSelection(row.provider, row.auth_mode, row.provider_account_id);
      return [
        row.provider,
        row.auth_mode === "provider_account"
          ? { mode: row.auth_mode, accountId: row.provider_account_id }
          : { mode: row.auth_mode },
      ];
    })
  ) as ModelProviderSelections;
}

export class AutomationModelProviderAuthStore {
  constructor(private readonly db: SqlDatabase) {}

  bindInserts(
    automationId: string,
    selections: ModelProviderSelections,
    now: number
  ): SqlStatement[] {
    return Object.entries(selections).map(([provider, selection]) =>
      this.db
        .prepare(
          `INSERT INTO automation_model_provider_auth
           (automation_id, provider, auth_mode, provider_account_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          automationId,
          provider,
          selection.mode,
          selection.mode === "provider_account" ? selection.accountId : null,
          now,
          now
        )
    );
  }

  bindReplace(
    automationId: string,
    selections: ModelProviderSelections,
    now: number
  ): SqlStatement[] {
    return [
      this.db
        .prepare("DELETE FROM automation_model_provider_auth WHERE automation_id = ?")
        .bind(automationId),
      ...this.bindInserts(automationId, selections, now),
    ];
  }

  async list(automationId: string): Promise<AutomationModelProviderAuthRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_model_provider_auth
         WHERE automation_id = ? ORDER BY provider`
      )
      .bind(automationId)
      .all<AutomationModelProviderAuthRow>();
    return result.results || [];
  }

  async listForAutomationIds(
    automationIds: string[]
  ): Promise<Map<string, AutomationModelProviderAuthRow[]>> {
    const rowsByAutomation = new Map<string, AutomationModelProviderAuthRow[]>();
    for (const id of automationIds) rowsByAutomation.set(id, []);
    if (automationIds.length === 0) return rowsByAutomation;

    const placeholders = automationIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_model_provider_auth
         WHERE automation_id IN (${placeholders}) ORDER BY automation_id, provider`
      )
      .bind(...automationIds)
      .all<AutomationModelProviderAuthRow>();
    for (const row of result.results ?? []) rowsByAutomation.get(row.automation_id)?.push(row);
    return rowsByAutomation;
  }
}
