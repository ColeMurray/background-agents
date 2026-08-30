import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

export interface SqlPredicate {
  sql: string;
  values: readonly unknown[];
}

export interface GuardedWrite {
  name: string;
  predicate: SqlPredicate;
}

export class GuardedWriteConflictError extends Error {
  constructor(
    readonly failedGuards: readonly string[],
    cause: unknown
  ) {
    super(`Guarded write rejected: ${failedGuards.join(", ")}`, { cause });
    this.name = "GuardedWriteConflictError";
  }

  has(name: string): boolean {
    return this.failedGuards.includes(name);
  }
}

export function guardAssertionSql(predicateSql: string): string {
  return `INSERT INTO guarded_write_assertion (singleton, satisfied)
    VALUES (1, CASE WHEN (${predicateSql}) THEN 1 ELSE 0 END)
    ON CONFLICT(singleton) DO UPDATE SET satisfied = excluded.satisfied`;
}

export function guardStatement(db: SqlDatabase, predicate: SqlPredicate): SqlStatement {
  return db.prepare(guardAssertionSql(predicate.sql)).bind(...predicate.values);
}

export async function predicateHolds(db: SqlDatabase, predicate: SqlPredicate): Promise<boolean> {
  const row = await db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS satisfied`)
    .bind(...predicate.values)
    .first<{ satisfied: number }>();
  return row?.satisfied === 1;
}

export async function runGuardedBatch(
  db: SqlDatabase,
  guards: readonly GuardedWrite[],
  statements: SqlStatement[]
): Promise<SqlResult[]> {
  if (guards.length === 0) return db.batch(statements);
  try {
    const results = await db.batch([
      ...guards.map((guard) => guardStatement(db, guard.predicate)),
      ...statements,
    ]);
    return results.slice(guards.length);
  } catch (cause) {
    const failedGuards: string[] = [];
    for (const guard of guards) {
      if (!(await predicateHolds(db, guard.predicate))) failedGuards.push(guard.name);
    }
    if (failedGuards.length === 0) throw cause;
    throw new GuardedWriteConflictError(failedGuards, cause);
  }
}
