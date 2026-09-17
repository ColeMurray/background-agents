import { describe, expect, it } from "vitest";
import { AuthorizationStore } from "./authorization-store";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

function result(changes: number, rows: unknown[] = []): SqlResult {
  return { results: rows, meta: { changes } };
}

function fakeDatabase(options: {
  batchResults?: SqlResult[];
  batchError?: Error;
  allResults?: unknown[];
  prepared?: Array<{ sql: string; values: unknown[] }>;
}): SqlDatabase {
  return {
    prepare: (sql) => {
      const prepared = { sql, values: [] as unknown[] };
      options.prepared?.push(prepared);
      const statement: SqlStatement = {
        bind: (...values) => {
          prepared.values = values;
          return statement;
        },
        first: async <T>() => null as T | null,
        run: async <T>() => result(0) as SqlResult<T>,
        all: async <T>() => result(0, options.allResults) as SqlResult<T>,
      };
      return statement;
    },
    batch: async <T>() => {
      if (options.batchError) throw options.batchError;
      return (options.batchResults ?? []) as SqlResult<T>[];
    },
  };
}

const replaceMemberStatusInput: Parameters<AuthorizationStore["replaceMemberStatus"]>[0] = {
  targetUserId: "target",
  suspended: true,
  actorUserId: "actor",
  requestId: "request",
  now: 100,
};

describe("AuthorizationStore", () => {
  it("maps persistence role fields at the store boundary", async () => {
    const store = new AuthorizationStore(
      fakeDatabase({
        allResults: [
          {
            id: "role_custom",
            key: null,
            name: "Custom",
            description: null,
            is_system: 0,
            assignment_count: "4",
          },
        ],
      })
    );

    await expect(store.listRoles()).resolves.toEqual([
      {
        id: "role_custom",
        key: null,
        name: "Custom",
        description: null,
        assignmentCount: 4,
      },
    ]);
  });

  it.each([
    "applied",
    "no_op",
    "actor_authorization_changed",
    "role_not_found",
    "member_not_found",
    "conflict",
  ] as const)("returns the %s member status replacement batch outcome", async (status) => {
    const store = new AuthorizationStore(
      fakeDatabase({
        batchResults: [result(0, [{ status }]), result(1), result(1), result(1)],
      })
    );

    await expect(store.replaceMemberStatus(replaceMemberStatusInput)).resolves.toEqual({
      status,
    });
  });

  it("does not classify an unexpected database failure as a conflict", async () => {
    const failure = new Error("database unavailable");
    const store = new AuthorizationStore(fakeDatabase({ batchError: failure }));

    await expect(store.replaceMemberStatus(replaceMemberStatusInput)).rejects.toBe(failure);
  });

  it("returns the mutation outcome from the audit insert that gates writes", async () => {
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const store = new AuthorizationStore(
      fakeDatabase({
        prepared,
        batchResults: [result(1, [{ status: "applied" }]), result(1), result(1)],
      })
    );

    await expect(store.replaceMemberStatus(replaceMemberStatusInput)).resolves.toEqual({
      status: "applied",
    });

    expect(prepared[0].sql).toContain("INSERT INTO authorization_audit_events");
    expect(prepared[0].sql).toContain("RETURNING CASE reason_code");
    expect(prepared).toHaveLength(3);
    expect(prepared.some(({ sql }) => /^SELECT\s+CASE/.test(sql.trim()))).toBe(false);
    const auditId = prepared[0].values.find(
      (value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value)
    );
    expect(auditId).toBeDefined();
    expect(prepared.slice(1).every(({ values }) => values.includes(auditId))).toBe(true);
  });
});
