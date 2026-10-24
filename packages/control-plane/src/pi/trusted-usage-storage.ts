import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { TRUSTED_USAGE_METER_KEY, type TrustedUsageStorage } from "../harness/trusted-usage-meter";

interface LegacyUsageStorage {
  get<T>(key: string): Promise<T | undefined>;
}

interface UsageRow {
  state_json: string;
}

/**
 * Trusted usage storage coordinated with Pi, Computer, and every host SQL use.
 *
 * The one legacy KV read is performed while this adapter owns the shared SQL
 * transaction queue, then copied into the SQL table. All later reads and every
 * write stay on the shared queue.
 */
export class PiTrustedUsageStorage implements TrustedUsageStorage {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly legacy: LegacyUsageStorage
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    this.assertKey(key);
    return this.database.transaction(async (transaction) => {
      const current = await this.read<T>(transaction);
      if (current !== undefined) return current;

      const legacy = await this.legacy.get<T>(TRUSTED_USAGE_METER_KEY);
      if (legacy === undefined) return undefined;
      await transaction.run(
        `INSERT INTO oi_pi_trusted_usage (singleton, state_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO NOTHING`,
        JSON.stringify(legacy),
        Date.now()
      );
      return legacy;
    });
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.assertKey(key);
    await this.database.run(
      `INSERT INTO oi_pi_trusted_usage (singleton, state_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (singleton) DO UPDATE
       SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(value),
      Date.now()
    );
  }

  private async read<T>(executor: SqliteExecutor): Promise<T | undefined> {
    const row = await executor.get<UsageRow>(
      "SELECT state_json FROM oi_pi_trusted_usage WHERE singleton = 1"
    );
    return row ? (JSON.parse(row.state_json) as T) : undefined;
  }

  private assertKey(key: string): void {
    if (key !== TRUSTED_USAGE_METER_KEY) throw new Error("Unknown trusted usage key");
  }
}
