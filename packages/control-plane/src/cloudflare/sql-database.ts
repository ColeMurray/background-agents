import type { SqlDatabase } from "../db/sql-database";
import { sqliteSetOperations } from "../db/sqlite-sets";

// Auth runtimes cache by database identity; metrics decorators remain request-scoped.
const adapters = new WeakMap<D1Database, SqlDatabase>();

/** Adapt each raw binding once, preserving statement ownership and batch semantics. */
export function createD1SqlDatabase(db: D1Database): SqlDatabase {
  const cached = adapters.get(db);
  if (cached) return cached;
  const database: SqlDatabase = db;
  const adapter: SqlDatabase = {
    prepare: (query) => db.prepare(query),
    batch: (statements) => database.batch(statements),
    ...sqliteSetOperations(db),
  };
  adapters.set(db, adapter);
  return adapter;
}
