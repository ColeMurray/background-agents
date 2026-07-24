import { describe, expect, it } from "vitest";

import { ApiTokenStore, EXPIRED_TOKEN_RETENTION_MS } from "./api-tokens";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

class RecordingStatement implements SqlStatement {
  boundValues: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly changes: number
  ) {}

  bind(...values: unknown[]): SqlStatement {
    this.boundValues = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return null;
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return { results: [], meta: { changes: this.changes } };
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return { results: [], meta: { changes: 0 } };
  }
}

class RecordingDatabase implements SqlDatabase {
  statements: RecordingStatement[] = [];

  constructor(private readonly changes: number) {}

  prepare(query: string): SqlStatement {
    const statement = new RecordingStatement(query, this.changes);
    this.statements.push(statement);
    return statement;
  }

  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }
}

describe("deleteExpired", () => {
  it("sweeps access rows by expires_at and family rows by family_expires_at", async () => {
    const db = new RecordingDatabase(3);
    const store = new ApiTokenStore(db);
    const now = 1_750_000_000_000;

    const deleted = await store.deleteExpired(now);

    expect(deleted).toBe(6);
    // Bare-column predicates on purpose: anything fancier skips the plain
    // indexes (migrations 0044/0045).
    expect(db.statements.map((statement) => statement.query)).toEqual([
      "DELETE FROM api_tokens WHERE family_expires_at IS NULL AND expires_at <= ?",
      "DELETE FROM api_tokens WHERE family_expires_at <= ?",
    ]);
    for (const statement of db.statements) {
      expect(statement.boundValues).toEqual([now - EXPIRED_TOKEN_RETENTION_MS]);
    }
  });

  it("returns 0 when nothing is past the retention window", async () => {
    const store = new ApiTokenStore(new RecordingDatabase(0));
    expect(await store.deleteExpired(Date.now())).toBe(0);
  });
});
