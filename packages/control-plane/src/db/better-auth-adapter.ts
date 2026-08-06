import { createAdapterFactory } from "better-auth/adapters";
import type { AdapterFactoryOptions } from "better-auth/adapters";
import { getSignInProviderIssuer } from "@open-inspect/shared/sign-in-provider";
import type { SqlDatabase } from "./sql-database";

/**
 * Better Auth adapter over the canonical tables (issue #1290 consolidation).
 *
 * Better Auth's user model IS canonical `users` and its account model IS
 * `user_identities` — mapped via the `modelName`/`fields` config in
 * `auth/user/better-auth.ts`. This adapter is a generic SQL executor on the
 * `SqlDatabase` seam: the factory hands it mapped table names and mapped
 * snake_case column names (model-name and field-name resolution happen above
 * this layer), so it contains no model knowledge beyond two schema-specific
 * row defaults (`provider_issuer`, blank `display_name`).
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
 * decorator. A batch-buffered transaction (or a real one via the D1→SQLite
 * portability rung) can be layered in later without touching callers.
 */

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

type FactoryWhere = {
  field: string;
  value: unknown;
  operator: string;
  connector: "AND" | "OR";
};

function compileCondition(entry: FactoryWhere): WhereClause {
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

function compileWhere(where: FactoryWhere[] | undefined): WhereClause {
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
    adapter: () => ({
      async create({ model, data }) {
        const table = assertIdentifier(model);
        const row = applyRowDefaults(table, data as Record<string, unknown>);
        const entries = Object.entries(row).filter(([, value]) => value !== undefined);
        const columns = entries.map(([column]) => assertIdentifier(column)).join(", ");
        const marks = entries.map(() => "?").join(", ");
        await db
          .prepare(`INSERT INTO ${table} (${columns}) VALUES (${marks})`)
          .bind(...entries.map(([, value]) => value))
          .run();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic passthrough per CustomAdapter contract
        return row as any;
      },
      async update({ model, where, update }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        const entries = Object.entries(update as Record<string, unknown>).filter(
          ([, value]) => value !== undefined
        );
        if (entries.length === 0) return null;
        const sets = entries.map(([column]) => `${assertIdentifier(column)} = ?`).join(", ");
        // RETURNING avoids the re-match problem: the where clause may target
        // the pre-update values (e.g. update token where token = old).
        const row = await db
          .prepare(`UPDATE ${table} SET ${sets}${compiled.clause} RETURNING *`)
          .bind(...entries.map(([, value]) => value), ...compiled.params)
          .first();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic passthrough per CustomAdapter contract
        return row as any;
      },
      async updateMany({ model, where, update }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        const entries = Object.entries(update).filter(([, value]) => value !== undefined);
        if (entries.length === 0) return 0;
        const sets = entries.map(([column]) => `${assertIdentifier(column)} = ?`).join(", ");
        const result = await db
          .prepare(`UPDATE ${table} SET ${sets}${compiled.clause}`)
          .bind(...entries.map(([, value]) => value), ...compiled.params)
          .run();
        return result.meta.changes;
      },
      async findOne({ model, where }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        const row = await db
          .prepare(`SELECT * FROM ${table}${compiled.clause} LIMIT 1`)
          .bind(...compiled.params)
          .first();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic passthrough per CustomAdapter contract
        return row as any;
      },
      async findMany({ model, where, limit, sortBy, offset }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
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
        const result = await db
          .prepare(sql)
          .bind(...params)
          .all();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic passthrough per CustomAdapter contract
        return result.results as any[];
      },
      async delete({ model, where }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        await db
          .prepare(`DELETE FROM ${table}${compiled.clause}`)
          .bind(...compiled.params)
          .run();
      },
      async deleteMany({ model, where }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        const result = await db
          .prepare(`DELETE FROM ${table}${compiled.clause}`)
          .bind(...compiled.params)
          .run();
        return result.meta.changes;
      },
      async count({ model, where }) {
        const table = assertIdentifier(model);
        const compiled = compileWhere(where as FactoryWhere[]);
        const row = await db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}${compiled.clause}`)
          .bind(...compiled.params)
          .first<{ count: number }>();
        return row?.count ?? 0;
      },
    }),
  };
  return createAdapterFactory(options);
}
