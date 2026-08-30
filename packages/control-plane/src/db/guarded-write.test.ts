import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import {
  GuardedWriteConflictError,
  guardSql,
  guardStatement,
  runGuardedBatch,
  type GuardedWrite,
} from "./guarded-write";

function result(changes = 0): SqlResult {
  return { results: [], meta: { changes } };
}

function fakeDatabase(options?: { batchError?: Error; predicateResults?: readonly number[] }): {
  db: SqlDatabase;
  queries: string[];
  bindings: unknown[][];
} {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  let predicateIndex = 0;
  const db = {
    prepare(query: string) {
      queries.push(query);
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          bindings.push(values);
          return statement;
        },
        first: async <T>() =>
          ({ satisfied: options?.predicateResults?.[predicateIndex++] ?? 1 }) as T,
        run: async <T>() => result() as SqlResult<T>,
        all: async <T>() => result() as SqlResult<T>,
      };
      return statement;
    },
    async batch<T>(statements: SqlStatement[]) {
      if (options?.batchError) throw options.batchError;
      return statements.map(() => result() as SqlResult<T>);
    },
  } satisfies SqlDatabase;
  return { db, queries, bindings };
}

const guard: GuardedWrite = {
  name: "authorization_guard",
  predicate: { sql: "user_id = ?", values: ["user-1"] },
};

describe("guarded writes", () => {
  it("owns the SQLite batch-abort expression and bindings", () => {
    const { db, queries, bindings } = fakeDatabase();

    guardStatement(db, guard.name, guard.predicate);

    expect(queries[0]).toBe(guardSql("authorization_guard", "user_id = ?"));
    expect(bindings[0]).toEqual(["user-1"]);
    expect(() => guardSql("invalid-name", "1 = 1")).toThrow("Invalid SQL guard name");
  });

  it("returns only mutation results after successful guards", async () => {
    const { db } = fakeDatabase();
    const statement = db.prepare("UPDATE users SET suspended_at = NULL");

    await expect(runGuardedBatch(db, [guard], [statement])).resolves.toHaveLength(1);
  });

  it("rechecks the same predicates and reports failed guard names", async () => {
    const failure = new Error("integer overflow");
    const { db } = fakeDatabase({ batchError: failure, predicateResults: [0] });

    await expect(runGuardedBatch(db, [guard], [])).rejects.toMatchObject({
      name: "GuardedWriteConflictError",
      failedGuards: ["authorization_guard"],
      cause: failure,
    });
  });

  it("preserves unrelated batch failures when every guard still holds", async () => {
    const failure = new Error("database unavailable");
    const { db } = fakeDatabase({ batchError: failure, predicateResults: [1] });

    await expect(runGuardedBatch(db, [guard], [])).rejects.toBe(failure);
    expect(new GuardedWriteConflictError([guard.name], failure).has(guard.name)).toBe(true);
  });
});
