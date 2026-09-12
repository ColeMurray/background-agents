import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { ModelPreferencesConflictError, ModelPreferencesStore } from "./model-preferences";

const GPT = "openai/gpt-5.4" as const;
const HAIKU = "anthropic/claude-haiku-4-5" as const;
const SONNET = "anthropic/claude-sonnet-4-6" as const;

class ConflictDatabase implements SqlDatabase {
  reads = 0;
  writes: unknown[][] = [];

  constructor(private readonly alwaysConflict = false) {}

  prepare(_query: string): SqlStatement {
    let values: unknown[] = [];
    const statement: SqlStatement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      first: async <T>() => this.read<T>(),
      run: async <T>() => this.write<T>(values),
      all: async <T>() => ({ results: [], meta: { changes: 0 } }) as SqlResult<T>,
    };
    return statement;
  }

  batch<T>(): Promise<SqlResult<T>[]> {
    throw new Error("Unexpected batch");
  }

  private async read<T>(): Promise<T | null> {
    this.reads += 1;
    return {
      enabled_models: JSON.stringify(this.reads === 1 ? [GPT] : [GPT, HAIKU]),
      revision: this.reads,
    } as T;
  }

  private async write<T>(values: unknown[]): Promise<SqlResult<T>> {
    this.writes.push(values);
    return {
      results: [],
      meta: { changes: this.alwaysConflict || this.writes.length === 1 ? 0 : 1 },
    };
  }
}

describe("ModelPreferencesStore", () => {
  it("reapplies a change to the winning value after a CAS conflict", async () => {
    const db = new ConflictDatabase();
    const store = new ModelPreferencesStore(db);

    await expect(store.applyChanges([{ modelId: SONNET, enabled: true }])).resolves.toEqual([
      GPT,
      HAIKU,
      SONNET,
    ]);
    expect(db.reads).toBe(2);
    expect(db.writes).toHaveLength(2);
    expect(JSON.parse(db.writes[1][0] as string)).toEqual([GPT, HAIKU, SONNET]);
  });

  it("reports contention after the bounded CAS retry limit", async () => {
    const db = new ConflictDatabase(true);

    await expect(
      new ModelPreferencesStore(db).applyChanges([{ modelId: SONNET, enabled: true }])
    ).rejects.toBeInstanceOf(ModelPreferencesConflictError);
    expect(db.reads).toBe(3);
    expect(db.writes).toHaveLength(3);
  });
});
