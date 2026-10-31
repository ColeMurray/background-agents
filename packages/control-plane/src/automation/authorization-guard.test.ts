import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import {
  automationExecutionPredicate,
  isAutomationExecutionAuthorized,
} from "./authorization-guard";

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
    expect(queries[0]).toContain("tm.team_id = a.owner_team_id AND tm.user_id = u.id");
    expect(queries[0]).toContain("t.archived_at IS NULL");
    expect(queries[0]).toContain("a.owner_team_id IS NULL OR");
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
});

describe("automation execution within a permission ceiling", () => {
  const request = {
    automationId: "automation-1",
    executionUserId: "requester-1",
    requiresRepositoryUse: true,
    requiresEnvironmentUse: false,
  } as const;

  it("adds nothing when the ceiling holds every permission execution needs", () => {
    expect(
      automationExecutionPredicate({
        ...request,
        permissionCeiling: ["sessions.create", "repositories.use"],
      })
    ).toEqual(automationExecutionPredicate(request));
  });

  it.each([
    ["sessions.create", ["repositories.use"]],
    ["repositories.use", ["sessions.create"]],
  ] as const)(
    "never authorizes without %s in the ceiling, whatever the role holds",
    (_withheld, ceiling) => {
      const predicate = automationExecutionPredicate({ ...request, permissionCeiling: ceiling });
      expect(predicate.sql).toContain("AND 1 = 0");
    }
  );

  it("passes a stored target requirement outside the ceiling only when no target is stored", () => {
    const predicate = automationExecutionPredicate({
      ...request,
      requiresRepositoryUse: "stored",
      permissionCeiling: ["sessions.create"],
    });
    expect(predicate.sql).toContain(
      "AND NOT EXISTS (SELECT 1 FROM automation_repositories stored_target"
    );
    // No role can supply the use permission, so the role guard is not offered as an alternative.
    expect(predicate.sql).not.toContain("OR (r.key IN");
  });

  it("ignores a ceiling permission no target needs", () => {
    expect(
      automationExecutionPredicate({
        ...request,
        requiresRepositoryUse: false,
        permissionCeiling: ["sessions.create"],
      })
    ).toEqual(automationExecutionPredicate({ ...request, requiresRepositoryUse: false }));
  });
});
