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
}): SqlDatabase {
  const statement: SqlStatement = {
    bind: () => statement,
    first: async <T>() => null as T | null,
    run: async <T>() => result(0) as SqlResult<T>,
    all: async <T>() => result(0, options.allResults) as SqlResult<T>,
  };
  return {
    prepare: () => statement,
    batch: async <T>() => {
      if (options.batchError) throw options.batchError;
      return (options.batchResults ?? []) as SqlResult<T>[];
    },
  };
}

const replaceRoleInput: Parameters<AuthorizationStore["replaceRole"]>[0] = {
  roleId: "role_custom",
  expectedRevision: 1,
  name: "Custom",
  normalizedName: "custom",
  description: null,
  permissions: [],
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
            revision: 2,
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
        isSystem: false,
        revision: 2,
        assignmentCount: 4,
      },
    ]);
  });

  it.each(["applied", "actor_authorization_changed", "not_found", "conflict"] as const)(
    "returns the %s role replacement batch outcome",
    async (status) => {
      const store = new AuthorizationStore(
        fakeDatabase({
          batchResults: [result(0, [{ status }]), result(1), result(1), result(1)],
        })
      );

      await expect(store.replaceRole(replaceRoleInput)).resolves.toEqual({ status });
    }
  );

  it("does not classify an unexpected database failure as a conflict", async () => {
    const failure = new Error("database unavailable");
    const store = new AuthorizationStore(fakeDatabase({ batchError: failure }));

    await expect(store.replaceRole(replaceRoleInput)).rejects.toBe(failure);
  });
});
