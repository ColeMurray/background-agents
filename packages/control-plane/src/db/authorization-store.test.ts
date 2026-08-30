import { describe, expect, it } from "vitest";
import { AuthorizationStore } from "./authorization-store";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

function result(changes: number, rows: unknown[] = []): SqlResult {
  return { results: rows, meta: { changes } };
}

function fakeDatabase(options: {
  batchResults?: SqlResult[];
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
    batch: async <T>() => (options.batchResults ?? []) as SqlResult<T>[],
  };
}

const replaceRoleInput: Parameters<AuthorizationStore["replaceRole"]>[0] = {
  roleId: "role_custom",
  expectedRevision: 1,
  nextRevision: 2,
  name: "Custom",
  normalizedName: "custom",
  description: null,
  permissions: [],
  actorUserId: "actor",
  actorAuthorizationVersion: 3,
  actorMutationId: "actor-mutation",
  mutationId: "role-mutation",
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

  it("reports actor conflicts before role revision conflicts", async () => {
    const store = new AuthorizationStore(
      fakeDatabase({
        batchResults: [result(0), result(0), result(0), result(0), result(0)],
      })
    );

    await expect(store.replaceRole(replaceRoleInput)).resolves.toBe("actor_conflict");
  });

  it("interprets the guarded role update position without exposing batch results", async () => {
    const conflictStore = new AuthorizationStore(
      fakeDatabase({
        batchResults: [result(1), result(1), result(1), result(0), result(0)],
      })
    );
    const successfulStore = new AuthorizationStore(
      fakeDatabase({
        batchResults: [result(1), result(1), result(1), result(1), result(1)],
      })
    );

    await expect(conflictStore.replaceRole(replaceRoleInput)).resolves.toBe("revision_conflict");
    await expect(successfulStore.replaceRole(replaceRoleInput)).resolves.toBe("succeeded");
  });
});
