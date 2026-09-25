import { z } from "zod";
import {
  providerAccountSwitchOperationSchema,
  providerSwitchGenerationSchema,
} from "@open-inspect/shared/types/provider-account-switch";
import type { SqlStorage } from "./sql-storage";

const stateSchema = z.object({
  operation: providerAccountSwitchOperationSchema.nullable(),
  lastAppliedOperation: providerAccountSwitchOperationSchema.nullable().default(null),
  history: z.array(providerAccountSwitchOperationSchema).max(32),
  capability: providerSwitchGenerationSchema.nullable(),
  supportedProviders: z
    .array(z.enum(["openai", "xai", "anthropic"]))
    .max(3)
    .default([]),
  epoch: z.number().int().nonnegative(),
});
export type ProviderSwitchRecord = z.infer<typeof stateSchema>;
export interface ProviderSwitchStore {
  read(): ProviderSwitchRecord;
  write(state: ProviderSwitchRecord): void;
}
export class ProviderAccountSwitchRepository implements ProviderSwitchStore {
  constructor(private readonly sql: SqlStorage) {}
  read(): ProviderSwitchRecord {
    const row = this.sql
      .exec("SELECT state FROM provider_account_recovery WHERE singleton = 1")
      .toArray()[0];
    const state = row
      ? stateSchema.parse(JSON.parse(z.object({ state: z.string() }).parse(row).state))
      : {
          operation: null,
          lastAppliedOperation: null,
          history: [],
          capability: null,
          supportedProviders: [],
          epoch: 0,
        };
    // Older recovery records kept successful application only in attempt history.
    state.lastAppliedOperation ??=
      [state.operation, ...[...state.history].reverse()].find(
        (operation) => operation?.phase === "applied"
      ) ?? null;
    return state;
  }
  write(state: ProviderSwitchRecord): void {
    this.sql.exec(
      "INSERT INTO provider_account_recovery (singleton, state) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state = excluded.state",
      JSON.stringify(stateSchema.parse(state))
    );
  }
}
