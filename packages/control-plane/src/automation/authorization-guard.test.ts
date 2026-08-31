import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { isAutomationExecutionAuthorized } from "./authorization-guard";

function recordingDb(): { db: SqlDatabase; bindings: unknown[][]; queries: string[] } {
  const bindings: unknown[][] = [];
  const queries: string[] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings.push(values);
      return statement;
    },
    first: async () => ({ authorized: 1 }),
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
      isAutomationExecutionAuthorized(db, "automation-1", ["sessions.collaborate"])
    ).resolves.toBe(true);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.[0]).toBe("automation-1");
    expect(queries[0]).toContain("a.id = ? AND a.deleted_at IS NULL");
    expect(queries[0]).toContain("automation_repositories");
    expect(queries[0]).toContain("automation_environments");
  });

  it("authorizes an explicit execution user instead of the stored owner", async () => {
    const { db, bindings, queries } = recordingDb();

    await expect(
      isAutomationExecutionAuthorized(db, "automation-1", [], "requester-1")
    ).resolves.toBe(true);

    expect(bindings[0]?.slice(0, 2)).toEqual(["requester-1", "automation-1"]);
    expect(queries[0]).toContain("JOIN users u ON u.id = ?");
  });
});
