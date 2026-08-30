import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import {
  bindAutomationAuthorizationGuard,
  bindAutomationExecutionGuard,
  isAutomationAuthorizationCurrent,
  isAutomationExecutionAuthorized,
} from "./authorization-guard";

function recordingDb(): { db: SqlDatabase; bindings: unknown[][] } {
  const bindings: unknown[][] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings.push(values);
      return statement;
    },
    first: async () => ({}),
  };
  return { db: { prepare: () => statement } as unknown as SqlDatabase, bindings };
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

    bindAutomationExecutionGuard(db, "automation-1");
    await isAutomationExecutionAuthorized(db, "automation-1");
    bindAutomationAuthorizationGuard(db, "automation-2", authorization, "manage", [
      "sessions.create",
      "repositories.use",
    ]);
    await isAutomationAuthorizationCurrent(db, "automation-2", authorization, "manage", [
      "sessions.create",
      "repositories.use",
    ]);

    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual(bindings[1]);
    expect(bindings[2]).toEqual(bindings[3]);
  });
});
