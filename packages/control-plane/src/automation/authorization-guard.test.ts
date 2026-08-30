import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { guardStatement, predicateHolds } from "../db/guarded-write";
import {
  automationAuthorizationGuard,
  automationExecutionGuard,
  isAutomationExecutionAuthorized,
} from "./authorization-guard";

function recordingDb(): { db: SqlDatabase; bindings: unknown[][]; queries: string[] } {
  const bindings: unknown[][] = [];
  const queries: string[] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings.push(values);
      return statement;
    },
    first: async () => ({}),
  };
  return {
    db: {
      prepare: (query: string) => {
        queries.push(query);
        return statement;
      },
    } as unknown as SqlDatabase,
    bindings,
    queries,
  };
}

const authorization: EffectiveAuthorization = {
  userId: "11111111111111111111111111111111",
  suspendedAt: null,
  role: { id: "role_builtin_member", key: "member", name: "Member" },
  permissions: [],
};

describe("automation authorization guards", () => {
  it("keeps guard and boolean predicate bindings in the same order", async () => {
    const { db, bindings } = recordingDb();

    const executionGuard = automationExecutionGuard("automation-1");
    guardStatement(db, executionGuard.name, executionGuard.predicate);
    await isAutomationExecutionAuthorized(db, "automation-1");
    const authorizationGuard = automationAuthorizationGuard(
      "automation-2",
      authorization,
      "manage",
      ["sessions.create", "repositories.use"]
    );
    guardStatement(db, authorizationGuard.name, authorizationGuard.predicate);
    await predicateHolds(db, authorizationGuard.predicate);

    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual(bindings[1]);
    expect(bindings[2]).toEqual(bindings[3]);
  });

  it("requires the target automation to remain non-deleted", () => {
    const { db, queries } = recordingDb();

    const authorizationGuard = automationAuthorizationGuard(
      "automation-1",
      authorization,
      "manage"
    );
    guardStatement(db, authorizationGuard.name, authorizationGuard.predicate);

    expect(queries[0]).toContain("a.id = ? AND a.deleted_at IS NULL");
  });
});
