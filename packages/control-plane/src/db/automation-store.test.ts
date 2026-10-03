import { describe, expect, it } from "vitest";
import { AutomationStore, type AutomationRow } from "./automation-store";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

function createFakeD1(options?: { allResults?: unknown[] }) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db: SqlDatabase = {
    prepare(sql) {
      const recorded = { sql, params: [] as unknown[] };
      statements.push(recorded);
      const statement: SqlStatement = {
        bind(...params) {
          recorded.params = params;
          return statement;
        },
        first: async () => null,
        all: async <T>() => ({
          results: (options?.allResults ?? []) as T[],
          meta: { changes: 0 },
        }),
        run: async () => ({ results: [], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
  return { db, statements };
}

const sampleRow: AutomationRow = {
  id: "auto_test1",
  name: "Daily sync",
  instructions: "Run daily sync tasks",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  harness: "opencode",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: "user-1",
  owner_team_id: null,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};

describe("AutomationStore", () => {
  it("projects legacy canonical owners in one lookup without repairing rows", async () => {
    const { db, statements } = createFakeD1({
      allResults: [{ provider_user_id: "4242", user_id: "user-legacy" }],
    });
    const legacy = { ...sampleRow, id: "legacy", user_id: null, created_by: "4242" };
    const anonymous = { ...sampleRow, id: "anon", user_id: null, created_by: "anonymous" };
    const canonical = { ...sampleRow, id: "canonical", user_id: "user-1" };

    const rows = await new AutomationStore(db).projectCanonicalOwners([
      legacy,
      anonymous,
      canonical,
    ]);

    expect(rows.map((row) => row.user_id)).toEqual(["user-legacy", null, "user-1"]);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("FROM user_identities");
    expect(statements[0].params).toEqual(["4242"]);
  });

  it("binds team visibility once, regardless of how many teams the viewer joined", async () => {
    const { db, statements } = createFakeD1();
    const memberships = new Map(
      Array.from({ length: MAX_D1_QUERY_PARAMETERS }, (_, i) => [`team_${i}`, "member" as const])
    );
    await new AutomationStore(db).list({
      limit: 25,
      nameSearch: "sync",
      teamId: "team_0",
      repoOwner: "acme",
      repoName: "web",
      viewer: {
        kind: "user",
        userId: "user-1",
        roleKey: "member",
        permissions: ["automations.read"],
        suspended: false,
        memberships,
      },
    });
    const [{ sql, params }] = statements;
    expect(params.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params).toContain("user-1");
    expect(params).not.toContain("team_1");
  });
});
