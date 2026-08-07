import { createAdapterFactory } from "better-auth/adapters";
import type { AdapterFactoryOptions, CustomAdapter } from "better-auth/adapters";
import { getSignInProviderIssuer } from "@open-inspect/shared/sign-in-provider";
import type { SqlDatabase } from "./sql-database";

/**
 * Better Auth adapter over the canonical tables (issue #1290 consolidation).
 *
 * Better Auth's user model IS canonical `users` and its account model IS
 * `user_identities` — mapped via the `modelName`/`fields` config in
 * `auth/user/better-auth.ts`. `CanonicalSqlAdapter` is a generic SQL executor
 * on the `SqlDatabase` seam implementing Better Auth's `CustomAdapter`
 * interface: the factory hands it mapped table names and mapped snake_case
 * column names (model-name and field-name resolution happen above this
 * layer), so it contains no model knowledge beyond two schema-specific row
 * defaults (`provider_issuer`, blank `display_name`).
 *
 * Representation contract with the canonical schema:
 * - Timestamps are INTEGER epoch milliseconds (Date ⇄ epoch in the
 *   config-level transforms; they also apply to where-clause values, which
 *   covers the SQL date comparisons in verification cleanup and session
 *   listing).
 * - Booleans are INTEGER 0/1 (`supportsBooleans: false` makes the factory
 *   convert both directions).
 * - Ids are caller-generated: `advanced.database.generateId` mints canonical
 *   32-hex ids for every model above this layer; this adapter never generates
 *   ids.
 *
 * Transactions are `false` (sequential execution): D1 exposes no interactive
 * transactions. The consolidated schema no longer depends on cross-table
 * atomicity for identity integrity — register writes `users` +
 * `user_identities` with client-generated ids, and a failure between the two
 * self-heals at the next sign-in through implicit linking and the claim
 * decorator. A batch-buffered transaction (or a real one, on an engine with
 * interactive transactions) can be layered in later without touching
 * callers.
 */

/** The factory-normalized where entry (`Required<Where>`), not re-exported by name. */
type CleanedWhere = Parameters<CustomAdapter["delete"]>[0]["where"][number];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier from Better Auth schema: ${name}`);
  }
  return name;
}

interface WhereClause {
  clause: string;
  params: unknown[];
}

function compileCondition(entry: CleanedWhere): WhereClause {
  const field = assertIdentifier(entry.field);
  const { value, operator } = entry;
  switch (operator) {
    case "eq":
      return value === null
        ? { clause: `${field} IS NULL`, params: [] }
        : { clause: `${field} = ?`, params: [value] };
    case "ne":
      return value === null
        ? { clause: `${field} IS NOT NULL`, params: [] }
        : { clause: `${field} <> ?`, params: [value] };
    case "lt":
      return { clause: `${field} < ?`, params: [value] };
    case "lte":
      return { clause: `${field} <= ?`, params: [value] };
    case "gt":
      return { clause: `${field} > ?`, params: [value] };
    case "gte":
      return { clause: `${field} >= ?`, params: [value] };
    case "in":
    case "not_in": {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) {
        // IN () is a SQL error; an empty list matches nothing / everything.
        return { clause: operator === "in" ? "0 = 1" : "1 = 1", params: [] };
      }
      const marks = values.map(() => "?").join(", ");
      const keyword = operator === "in" ? "IN" : "NOT IN";
      return { clause: `${field} ${keyword} (${marks})`, params: values };
    }
    case "contains":
      return { clause: `${field} LIKE ?`, params: [`%${String(value)}%`] };
    case "starts_with":
      return { clause: `${field} LIKE ?`, params: [`${String(value)}%`] };
    case "ends_with":
      return { clause: `${field} LIKE ?`, params: [`%${String(value)}`] };
    default:
      throw new Error(`Unsupported where operator: ${operator}`);
  }
}

function compileWhere(where: CleanedWhere[] | undefined): WhereClause {
  if (!where || where.length === 0) return { clause: "", params: [] };
  let clause = "";
  const params: unknown[] = [];
  for (const [index, entry] of where.entries()) {
    const condition = compileCondition(entry);
    clause += index === 0 ? "" : ` ${entry.connector === "OR" ? "OR" : "AND"} `;
    clause += condition.clause;
    params.push(...condition.params);
  }
  return { clause: ` WHERE ${clause}`, params };
}

/**
 * Schema-specific row defaults Better Auth cannot supply itself: the issuer
 * URL derives from the provider, and Better Auth's required `name` maps onto
 * nullable `display_name` where an empty string must mean absent.
 */
function applyRowDefaults(model: string, data: Record<string, unknown>): Record<string, unknown> {
  if (model === "user_identities" && data.provider_issuer === undefined) {
    return {
      ...data,
      provider_issuer:
        typeof data.provider === "string" ? getSignInProviderIssuer(data.provider) : null,
    };
  }
  if (model === "users" && data.display_name === "") {
    return { ...data, display_name: null };
  }
  return data;
}

class CanonicalSqlAdapter implements CustomAdapter {
  constructor(private readonly db: SqlDatabase) {}

  async create<T extends Record<string, unknown>>({
    model,
    data,
  }: {
    model: string;
    data: T;
    select?: string[] | undefined;
  }): Promise<T> {
    const table = assertIdentifier(model);
    const row = applyRowDefaults(table, data);
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    const columns = entries.map(([column]) => assertIdentifier(column)).join(", ");
    const marks = entries.map(() => "?").join(", ");
    await this.db
      .prepare(`INSERT INTO ${table} (${columns}) VALUES (${marks})`)
      .bind(...entries.map(([, value]) => value))
      .run();
    return row as T;
  }

  async update<T>({
    model,
    where,
    update,
  }: {
    model: string;
    where: CleanedWhere[];
    update: T;
  }): Promise<T | null> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    const entries = Object.entries(update as Record<string, unknown>).filter(
      ([, value]) => value !== undefined
    );
    if (entries.length === 0) return null;
    const sets = entries.map(([column]) => `${assertIdentifier(column)} = ?`).join(", ");
    // RETURNING avoids the re-match problem: the where clause may target
    // the pre-update values (e.g. update token where token = old).
    return this.db
      .prepare(`UPDATE ${table} SET ${sets}${compiled.clause} RETURNING *`)
      .bind(...entries.map(([, value]) => value), ...compiled.params)
      .first<T>();
  }

  async updateMany({
    model,
    where,
    update,
  }: {
    model: string;
    where: CleanedWhere[];
    update: Record<string, unknown>;
  }): Promise<number> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    const entries = Object.entries(update).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return 0;
    const sets = entries.map(([column]) => `${assertIdentifier(column)} = ?`).join(", ");
    const result = await this.db
      .prepare(`UPDATE ${table} SET ${sets}${compiled.clause}`)
      .bind(...entries.map(([, value]) => value), ...compiled.params)
      .run();
    return result.meta.changes;
  }

  async findOne<T>({ model, where }: { model: string; where: CleanedWhere[] }): Promise<T | null> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    return this.db
      .prepare(`SELECT * FROM ${table}${compiled.clause} LIMIT 1`)
      .bind(...compiled.params)
      .first<T>();
  }

  async findMany<T>({
    model,
    where,
    limit,
    sortBy,
    offset,
  }: {
    model: string;
    where?: CleanedWhere[] | undefined;
    limit: number;
    sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
    offset?: number | undefined;
  }): Promise<T[]> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    let sql = `SELECT * FROM ${table}${compiled.clause}`;
    if (sortBy) {
      const direction = sortBy.direction === "desc" ? "DESC" : "ASC";
      sql += ` ORDER BY ${assertIdentifier(sortBy.field)} ${direction}`;
    }
    sql += ` LIMIT ?`;
    const params: unknown[] = [...compiled.params, limit];
    if (offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(offset);
    }
    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return result.results;
  }

  async delete({ model, where }: { model: string; where: CleanedWhere[] }): Promise<void> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    await this.db
      .prepare(`DELETE FROM ${table}${compiled.clause}`)
      .bind(...compiled.params)
      .run();
  }

  async deleteMany({ model, where }: { model: string; where: CleanedWhere[] }): Promise<number> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    const result = await this.db
      .prepare(`DELETE FROM ${table}${compiled.clause}`)
      .bind(...compiled.params)
      .run();
    return result.meta.changes;
  }

  /**
   * Native atomic single-row consume, one round trip. Better Auth uses this
   * for one-shot verification state (the OAuth handshake); the rowid
   * subselect keeps the contract of deleting at most one matching row.
   * Without it the factory falls back to findMany + deleteMany, which
   * `transaction: false` would leave racy.
   */
  async consumeOne<T>({
    model,
    where,
  }: {
    model: string;
    where: CleanedWhere[];
  }): Promise<T | null> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    return this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE rowid IN (SELECT rowid FROM ${table}${compiled.clause} LIMIT 1)
         RETURNING *`
      )
      .bind(...compiled.params)
      .first<T>();
  }

  async count({
    model,
    where,
  }: {
    model: string;
    where?: CleanedWhere[] | undefined;
  }): Promise<number> {
    const table = assertIdentifier(model);
    const compiled = compileWhere(where);
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}${compiled.clause}`)
      .bind(...compiled.params)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
}

export function createCanonicalBetterAuthAdapter(db: SqlDatabase) {
  const options: AdapterFactoryOptions = {
    config: {
      adapterId: "canonical-sql",
      adapterName: "Canonical SQL adapter",
      usePlural: false,
      supportsDates: true,
      supportsBooleans: false,
      supportsJSON: false,
      supportsNumericIds: false,
      transaction: false,
      customTransformInput({ data, fieldAttributes }) {
        if (fieldAttributes.type === "date" && data instanceof Date) {
          return data.getTime();
        }
        return data;
      },
      customTransformOutput({ data, fieldAttributes }) {
        if (fieldAttributes.type === "date" && typeof data === "number") {
          return new Date(data);
        }
        return data;
      },
    },
    adapter: () => new CanonicalSqlAdapter(db),
  };
  return createAdapterFactory(options);
}
