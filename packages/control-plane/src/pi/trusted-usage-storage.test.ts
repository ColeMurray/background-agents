import { describe, expect, it, vi } from "vitest";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { TRUSTED_USAGE_METER_KEY } from "../harness/trusted-usage-meter";
import { PiTrustedUsageStorage } from "./trusted-usage-storage";

class MemoryDatabase implements SqliteDatabase {
  stateJson: string | undefined;
  transactionCalls = 0;
  async transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return callback(this);
  }
  readonly run = vi.fn(async (sql: string, ...params: SqliteValue[]) => {
    if (sql.includes("oi_pi_trusted_usage")) this.stateJson = String(params[0]);
  });
  async get<T extends object>(sql: string): Promise<T | undefined> {
    if (!sql.includes("oi_pi_trusted_usage") || this.stateJson === undefined) return undefined;
    return { state_json: this.stateJson } as T;
  }
  async exec(): Promise<void> {}
  async all<T extends object>(): Promise<T[]> {
    return [];
  }
  async close(): Promise<void> {}
}

describe("PiTrustedUsageStorage", () => {
  it("migrates the legacy value while holding the shared SQLite transaction queue", async () => {
    const database = new MemoryDatabase();
    const getLegacy = vi.fn();
    const legacy = {
      async get<T>(): Promise<T | undefined> {
        getLegacy();
        return { version: 1, costUsd: 2 } as T;
      },
    };
    const storage = new PiTrustedUsageStorage(database, legacy);

    await expect(storage.get(TRUSTED_USAGE_METER_KEY)).resolves.toEqual({
      version: 1,
      costUsd: 2,
    });

    expect(database.transactionCalls).toBe(1);
    expect(database.stateJson).toBe(JSON.stringify({ version: 1, costUsd: 2 }));
  });

  it("routes every usage write through the shared SQLite database", async () => {
    const database = new MemoryDatabase();
    const getLegacy = vi.fn();
    const legacy = {
      async get<T>(): Promise<T | undefined> {
        getLegacy();
        return undefined;
      },
    };
    const storage = new PiTrustedUsageStorage(database, legacy);

    await storage.put(TRUSTED_USAGE_METER_KEY, { version: 1, costUsd: 3 });

    expect(database.run).toHaveBeenCalledOnce();
    expect(getLegacy).not.toHaveBeenCalled();
  });
});
