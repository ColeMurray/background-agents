import { describe, expect, it } from "vitest";
import { AutomationStore, toAutomationRun, type AutomationRow } from "./automation-store";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

function createFakeD1(options?: { allResults?: unknown[]; batchResults?: unknown[][] }) {
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
    batch: async <T>() =>
      (options?.batchResults ?? []).map((results) => ({
        results: results as T[],
        meta: { changes: 0 },
      })),
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

const invocationRow = {
  id: "inv_1",
  automation_id: "auto_test1",
  source: "manual",
  scheduled_at: null,
  skip_reason: null,
  created_at: 1000,
  derived_status: "completed",
  derived_completed_at: 1200,
};

const enrichedRunRow = {
  id: "run_1",
  automation_id: "auto_test1",
  invocation_id: "inv_1",
  session_id: null,
  status: "completed",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 1000,
  started_at: null,
  completed_at: 1200,
  execution_deadline_at: null,
  created_at: 1000,
  repo_owner: null,
  repo_name: null,
  repo_id: null,
  base_branch: null,
  environment_id: null,
  session_title: null,
  artifact_summary: null,
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

  it("parses invocation child run rows and preserves nullable fields", async () => {
    const { db } = createFakeD1({ batchResults: [[invocationRow], [enrichedRunRow]] });

    const invocation = await new AutomationStore(db).getInvocation("auto_test1", "inv_1");

    expect(invocation?.runs).toEqual([
      {
        id: "run_1",
        automationId: "auto_test1",
        invocationId: "inv_1",
        sessionId: null,
        status: "completed",
        skipReason: null,
        failureReason: null,
        scheduledAt: 1000,
        startedAt: null,
        completedAt: 1200,
        createdAt: 1000,
        sessionTitle: null,
        artifactSummary: null,
        repoOwner: null,
        repoName: null,
        repoId: null,
        baseBranch: null,
        environmentId: null,
      },
    ]);
  });

  it("rejects malformed invocation child run rows consistently across detail and list", async () => {
    const malformedRun = { ...enrichedRunRow, status: "done" };
    const detail = createFakeD1({ batchResults: [[invocationRow], [malformedRun]] });
    const list = createFakeD1({
      batchResults: [[{ count: 1 }], [invocationRow]],
      allResults: [malformedRun],
    });

    await expect(
      new AutomationStore(detail.db).getInvocation("auto_test1", "inv_1")
    ).rejects.toThrow();
    await expect(
      new AutomationStore(list.db).listInvocations("auto_test1", { limit: 25, offset: 0 })
    ).rejects.toThrow();
    expect(() => toAutomationRun(malformedRun)).toThrow();
  });

  it("rejects partial invocation child run rows", async () => {
    const partialRun = { ...enrichedRunRow, id: undefined };
    const { db } = createFakeD1({ batchResults: [[invocationRow], [partialRun]] });

    await expect(new AutomationStore(db).getInvocation("auto_test1", "inv_1")).rejects.toThrow();
  });
});
