import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { isAutomationExecutionAuthorized, isPrincipalAuthorized } from "./authorization-guard";

function recordingDb(result: { authorized: number } | null = { authorized: 1 }): {
  db: SqlDatabase;
  bindings: unknown[][];
  queries: string[];
} {
  const bindings: unknown[][] = [];
  const queries: string[] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings.push(values);
      return statement;
    },
    first: async () => result,
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

describe("automation execution authorization", () => {
  it("queries owner and target-use permissions with stable bindings", async () => {
    const { db, bindings, queries } = recordingDb();

    await expect(
      isAutomationExecutionAuthorized(db, {
        automationId: "automation-1",
        requiresRepositoryUse: true,
        requiresEnvironmentUse: true,
      })
    ).resolves.toBe(true);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.[0]).toBe("automation-1");
    expect(queries[0]).toContain("a.id = ? AND a.deleted_at IS NULL");
    expect(queries[0]).not.toContain("automation_repositories");
    expect(queries[0]).not.toContain("automation_environments");
  });

  it("authorizes an explicit execution user instead of the stored owner", async () => {
    const { db, bindings, queries } = recordingDb();

    await expect(
      isAutomationExecutionAuthorized(db, {
        automationId: "automation-1",
        executionUserId: "requester-1",
        requiresRepositoryUse: false,
        requiresEnvironmentUse: false,
      })
    ).resolves.toBe(true);

    expect(bindings[0]?.slice(0, 2)).toEqual(["requester-1", "automation-1"]);
    expect(queries[0]).toContain("JOIN users u ON u.id = ?");
  });

  it("authorizes collaboration without requiring automation launch permissions", async () => {
    const { db, bindings, queries } = recordingDb();

    await expect(isPrincipalAuthorized(db, "actor-1", "sessions.collaborate")).resolves.toBe(true);

    expect(bindings[0]?.[0]).toBe("actor-1");
    expect(queries[0]).not.toContain("automations");
  });

  it.each([
    { name: "denied", result: { authorized: 0 } },
    { name: "missing row", result: null },
  ])("fails closed when automation execution is $name", async ({ result }) => {
    const { db } = recordingDb(result);

    await expect(
      isAutomationExecutionAuthorized(db, {
        automationId: "automation-1",
        requiresRepositoryUse: true,
        requiresEnvironmentUse: true,
      })
    ).resolves.toBe(false);
  });

  it.each([
    { name: "denied", result: { authorized: 0 } },
    { name: "missing row", result: null },
  ])("fails closed when principal authorization is $name", async ({ result }) => {
    const { db } = recordingDb(result);

    await expect(isPrincipalAuthorized(db, "actor-1", "sessions.collaborate")).resolves.toBe(false);
  });
});
