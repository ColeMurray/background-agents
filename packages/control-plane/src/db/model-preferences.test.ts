import { describe, expect, it } from "vitest";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import {
  ModelPreferencesConflictError,
  ModelPreferencesStore,
  getEffectiveEnabledModels,
} from "./model-preferences";

const GPT = "openai/gpt-5.4" as const;
const HAIKU = "anthropic/claude-haiku-4-5" as const;
const SONNET = "anthropic/claude-sonnet-4-6" as const;

class ConflictDatabase implements SqlDatabase {
  reads = 0;
  writes: unknown[][] = [];
  private models: string[] = [GPT];
  private revision = 1;

  constructor(
    private readonly alwaysConflict = false,
    private readonly storedValue?: string
  ) {}

  prepare(query: string): SqlStatement {
    let values: unknown[] = [];
    const statement: SqlStatement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      first: async <T>() => {
        this.reads += 1;
        return {
          enabled_models: this.storedValue ?? JSON.stringify(this.models),
          revision: this.revision,
        } as T;
      },
      run: async <T>() => this.write<T>(query, values),
      all: async <T>() => ({ results: [], meta: { changes: 0 } }) as SqlResult<T>,
    };
    return statement;
  }

  batch<T>(): Promise<SqlResult<T>[]> {
    throw new Error("Unexpected batch");
  }

  private async write<T>(query: string, values: unknown[]): Promise<SqlResult<T>> {
    if (!query.includes("revision = revision + 1") || !query.includes("AND revision = ?")) {
      throw new Error("Model preference updates must compare and increment the revision");
    }

    this.writes.push(values);
    const expectedRevision = values[2];
    if (typeof expectedRevision !== "number") throw new Error("Expected a bound revision");

    if (this.alwaysConflict || this.writes.length === 1) {
      this.models = this.writes.length === 1 ? [GPT, HAIKU] : this.models;
      this.revision += 1;
    }

    if (expectedRevision !== this.revision) {
      return { results: [], meta: { changes: 0 } };
    }

    this.models = JSON.parse(values[0] as string);
    this.revision += 1;
    return { results: [], meta: { changes: 1 } };
  }
}

describe("ModelPreferencesStore", () => {
  it("uses defaults for malformed storage", async () => {
    const db = new ConflictDatabase(false, "{");
    const snapshot = await new ModelPreferencesStore(db).getSnapshot();

    expect(snapshot).toEqual({
      enabledModels: DEFAULT_ENABLED_MODELS,
      revision: 1,
    });
    await expect(getEffectiveEnabledModels(db)).resolves.toEqual(DEFAULT_ENABLED_MODELS);
  });

  it("reapplies a change to the winning value after a CAS conflict", async () => {
    const db = new ConflictDatabase();
    const store = new ModelPreferencesStore(db);

    await expect(store.applyChanges([{ modelId: SONNET, enabled: true }])).resolves.toMatchObject({
      enabledModels: [GPT, HAIKU, SONNET],
      revision: 3,
    });
    expect(db.reads).toBe(2);
    expect(db.writes).toHaveLength(2);
    expect(db.writes.map((values) => values[2])).toEqual([1, 2]);
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
