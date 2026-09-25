/**
 * Unit tests for AutomationStore.
 *
 * Uses a minimal FakeD1Database that records prepared statements and returns
 * configurable results. For full integration tests (with real D1 + migrations),
 * see test/integration/.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AutomationStore,
  isDuplicateKeyError,
  parseAutomationTriggerFields,
  toAutomation,
  toAutomationRun,
  type AutomationRow,
  type AutomationRunRow,
  type EnrichedRunRow,
} from "./automation-store";

// ─── Fake D1 helpers ─────────────────────────────────────────────────────────

interface FakeStatement {
  sql: string;
  params: unknown[];
}

function createFakeD1(options?: { allResults?: unknown[] }) {
  const statements: FakeStatement[] = [];

  const fakeStmt = {
    bind(...params: unknown[]) {
      statements[statements.length - 1].params = params;
      return fakeStmt;
    },
    async first<T>(): Promise<T | null> {
      return null;
    },
    async all<T>(): Promise<D1Result<T>> {
      return {
        results: (options?.allResults ?? []) as T[],
        success: true,
        meta: { duration: 0, changes: 0 },
      } as unknown as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      return {
        results: [],
        success: true,
        meta: { duration: 0, changes: 1 },
      } as unknown as D1Result;
    },
  };

  const db = {
    prepare(sql: string) {
      statements.push({ sql, params: [] });
      return fakeStmt;
    },
    async batch(stmts: D1PreparedStatement[]) {
      return stmts.map(() => ({
        results: [],
        success: true,
        meta: { duration: 0, changes: 1 },
      }));
    },
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return { db, statements };
}

// ─── Sample data ─────────────────────────────────────────────────────────────

const now = Date.now();

const sampleRow: AutomationRow = {
  id: "auto_test1",
  name: "Daily sync",
  instructions: "Run daily sync tasks",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  harness: "opencode" as const,
  reasoning_effort: null,
  enabled: 1,
  next_run_at: now + 86400000,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: "11111111111111111111111111111111",
  created_at: now,
  updated_at: now,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};

const sampleRunRow: AutomationRunRow = {
  id: "run_test1",
  automation_id: "auto_test1",
  session_id: null,
  status: "starting",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: now,
  started_at: null,
  execution_deadline_at: null,
  completed_at: null,
  created_at: now,
  invocation_id: "inv-test1",
  repo_owner: null,
  repo_name: null,
  repo_id: null,
  base_branch: null,
  environment_id: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("toAutomation", () => {
  it("converts row to camelCase Automation", () => {
    const automation = toAutomation(
      sampleRow,
      [
        {
          automation_id: "auto_test1",
          repo_owner: "acme",
          repo_name: "web-app",
          repo_id: 12345,
          base_branch: "main",
          created_at: now,
          updated_at: now,
        },
      ],
      [],
      []
    );
    expect(automation.id).toBe("auto_test1");
    expect(automation.repositories).toEqual([
      { repoOwner: "acme", repoName: "web-app", repoId: 12345, baseBranch: "main" },
    ]);
    expect(automation.scheduleCron).toBe("0 9 * * *");
    expect(automation.scheduleTz).toBe("UTC");
    expect(automation.reasoningEffort).toBeNull();
    expect(automation.enabled).toBe(true);
    expect(automation.triggerType).toBe("schedule");
    expect(automation.eventType).toBeNull();
    expect(automation.triggerConfig).toBeNull();
    expect(automation.consecutiveFailures).toBe(0);
    expect(automation.createdBy).toBe("user-1");
    expect(automation.userId).toBe("11111111111111111111111111111111");
    expect(automation.environmentIds).toEqual([]);
  });

  it("maps environment rows to environmentIds", () => {
    const automation = toAutomation(
      sampleRow,
      [],
      [
        {
          automation_id: "auto_test1",
          environment_id: "env_abc",
          created_at: now,
          updated_at: now,
        },
        {
          automation_id: "auto_test1",
          environment_id: "env_def",
          created_at: now,
          updated_at: now,
        },
      ],
      []
    );
    expect(automation.environmentIds).toEqual(["env_abc", "env_def"]);
  });

  it("converts enabled=0 to false", () => {
    const automation = toAutomation({ ...sampleRow, enabled: 0 }, [], [], []);
    expect(automation.enabled).toBe(false);
  });

  it("parses stored trigger_config through the trigger schema", () => {
    const triggerConfig = {
      conditions: [
        {
          type: "text_match",
          operator: "contains",
          value: { pattern: "urgent" },
        },
      ],
    };

    const automation = toAutomation(
      {
        ...sampleRow,
        trigger_type: "webhook",
        event_type: "webhook.received",
        trigger_config: JSON.stringify(triggerConfig),
      },
      [],
      [],
      []
    );

    expect(automation.triggerType).toBe("webhook");
    expect(automation.triggerConfig).toEqual(triggerConfig);
  });

  it("rejects malformed stored trigger_config instead of asserting it", () => {
    expect(() =>
      toAutomation(
        {
          ...sampleRow,
          trigger_type: "webhook",
          trigger_config: JSON.stringify({ conditions: [{ type: "unknown" }] }),
        },
        [],
        [],
        []
      )
    ).toThrow();
  });

  it("rejects unknown stored trigger_type instead of asserting it", () => {
    expect(() => toAutomation({ ...sampleRow, trigger_type: "unknown" }, [], [], [])).toThrow();
  });

  it("maps repo-less automations to an empty repository list", () => {
    const automation = toAutomation(sampleRow, [], [], []);
    expect(automation.repositories).toEqual([]);
  });

  it("hydrates provider selections from auth rows", () => {
    const automation = toAutomation(
      sampleRow,
      [],
      [],
      [
        {
          automation_id: sampleRow.id,
          provider: "openai",
          auth_mode: "provider_account",
          provider_account_id: "0123456789abcdef0123456789abcdef",
          created_at: now,
          updated_at: now,
        },
        {
          automation_id: sampleRow.id,
          provider: "xai",
          auth_mode: "api_key",
          provider_account_id: null,
          created_at: now,
          updated_at: now,
        },
      ]
    );

    expect(automation.providerSelections).toEqual({
      openai: {
        mode: "provider_account",
        accountId: "0123456789abcdef0123456789abcdef",
      },
      xai: { mode: "api_key" },
    });
  });
});

describe("parseAutomationTriggerFields", () => {
  it("decodes persisted trigger fields at the storage boundary", () => {
    const triggerConfig = {
      conditions: [{ type: "text_match", operator: "contains", value: { pattern: "urgent" } }],
    };

    expect(
      parseAutomationTriggerFields({
        ...sampleRow,
        trigger_type: "webhook",
        trigger_config: JSON.stringify(triggerConfig),
      })
    ).toEqual({ triggerType: "webhook", triggerConfig });
  });

  it("rejects an unknown persisted trigger type", () => {
    expect(() => parseAutomationTriggerFields({ ...sampleRow, trigger_type: "made_up" })).toThrow();
  });

  it("rejects a malformed persisted trigger config", () => {
    expect(() =>
      parseAutomationTriggerFields({
        ...sampleRow,
        trigger_type: "webhook",
        trigger_config: JSON.stringify({ conditions: [{ type: "made_up" }] }),
      })
    ).toThrow();
  });
});

describe("toAutomationRun", () => {
  it("converts enriched row to camelCase AutomationRun", () => {
    const enriched: EnrichedRunRow = {
      ...sampleRunRow,
      session_title: "Test Session",
      artifact_summary: "2 artifacts",
    };
    const run = toAutomationRun(enriched);
    expect(run.id).toBe("run_test1");
    expect(run.automationId).toBe("auto_test1");
    expect(run.sessionTitle).toBe("Test Session");
    expect(run.artifactSummary).toBe("2 artifacts");
    expect(run.status).toBe("starting");
  });
});

describe("AutomationStore", () => {
  describe("list", () => {
    it("returns a bounded page", async () => {
      const { db } = createFakeD1({
        allResults: [sampleRow],
      });
      const store = new AutomationStore(db);
      const result = await store.list({ limit: 25 });
      expect(result.automations).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("updateRun", () => {
    it("skips update when no fields provided", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.updateRun("run_test1", {});
      expect(statements).toHaveLength(0);
    });
  });

  describe("claimRunSession", () => {
    it("claims only a starting run", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);

      await store.claimRunSession("run_test1", "session-1", now, now + 1000);

      expect(statements[0].sql).toContain("SET status = 'running'");
      expect(statements[0].sql).toContain("WHERE id = ? AND status = 'starting'");
      expect(statements[0].params).toEqual(["session-1", now, now + 1000, "run_test1"]);
    });
  });

  describe("schedule advancement", () => {
    const invocation = {
      id: "inv-1",
      automation_id: "auto_test1",
      source: "schedule" as const,
      scheduled_at: now,
      trigger_key: null,
      concurrency_key: null,
      trigger_metadata: null,
      skip_reason: null,
      failure_counted_at: null,
      created_at: now,
      updated_at: now,
    };

    it("advances a guarded invocation only while it still owns the claimed slot", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);

      await store.insertInvocationGuarded({
        invocation,
        children: [sampleRunRow],
        overlapScope: { kind: "automation" },
        advanceSchedule: { fromSlot: now, nextRunAt: now + 60_000 },
      });

      const advance = statements.find((statement) =>
        statement.sql.includes("SET next_run_at = ?")
      )!;
      // Compare-and-set on the claimed slot, not a monotonic timestamp guard:
      // "any later value wins" lets a loser advance again from the winner's
      // successor and skip a slot entirely.
      expect(advance.sql).toContain("next_run_at = ?");
      expect(advance.sql).not.toContain("next_run_at < ?");
      expect(advance.params.at(-1)).toBe(now);
    });
  });
});

describe("isDuplicateKeyError", () => {
  it("matches the trigger-key dedup index violation", () => {
    expect(
      isDuplicateKeyError(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: automation_invocations.automation_id, automation_invocations.trigger_key"
        )
      )
    ).toBe(true);
  });

  it("ignores unrelated UNIQUE violations so they surface as real errors", () => {
    expect(isDuplicateKeyError(new Error("UNIQUE constraint failed: automation_runs.id"))).toBe(
      false
    );
    expect(isDuplicateKeyError(new Error("some other write failure"))).toBe(false);
  });

  it("handles non-Error throwables", () => {
    expect(isDuplicateKeyError("UNIQUE constraint failed: x.trigger_key")).toBe(true);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
