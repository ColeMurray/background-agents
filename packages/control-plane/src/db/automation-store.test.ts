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

function createFakeD1(options?: {
  firstResult?: unknown;
  allResults?: unknown[];
  changes?: number;
}) {
  const statements: FakeStatement[] = [];

  const fakeStmt = {
    bind(...params: unknown[]) {
      statements[statements.length - 1].params = params;
      return fakeStmt;
    },
    async first<T>(): Promise<T | null> {
      return (options?.firstResult as T) ?? null;
    },
    async all<T>(): Promise<D1Result<T>> {
      return {
        results: (options?.allResults ?? []) as T[],
        success: true,
        meta: { duration: 0, changes: options?.changes ?? 0 },
      } as unknown as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      return {
        results: [],
        success: true,
        meta: { duration: 0, changes: options?.changes ?? 1 },
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
  reasoning_effort: null,
  enabled: 1,
  next_run_at: now + 86400000,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: null,
  created_at: now,
  updated_at: now,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
  environment_id: null,
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
  completed_at: null,
  created_at: now,
  invocation_id: null,
  repo_owner: null,
  repo_name: null,
  repo_id: null,
  base_branch: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("toAutomation", () => {
  it("converts row to camelCase Automation", () => {
    const automation = toAutomation(sampleRow, [
      {
        automation_id: "auto_test1",
        repo_owner: "acme",
        repo_name: "web-app",
        repo_id: 12345,
        base_branch: "main",
        created_at: now,
        updated_at: now,
      },
    ]);
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
    expect(automation.environmentId).toBeNull();
  });

  it("maps environment_id", () => {
    const automation = toAutomation({ ...sampleRow, environment_id: "env_abc" }, []);
    expect(automation.environmentId).toBe("env_abc");
  });

  it("converts enabled=0 to false", () => {
    const automation = toAutomation({ ...sampleRow, enabled: 0 }, []);
    expect(automation.enabled).toBe(false);
  });

  it("maps repo-less automations to an empty repository list", () => {
    const automation = toAutomation(sampleRow, []);
    expect(automation.repositories).toEqual([]);
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
  describe("create", () => {
    it("inserts all fields", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.create(sampleRow);

      expect(statements).toHaveLength(1);
      expect(statements[0].sql).toContain("INSERT INTO automations");
      expect(statements[0].params[0]).toBe("auto_test1");
      expect(statements[0].params[1]).toBe("Daily sync");
      expect(statements[0].params[2]).toBe("Run daily sync tasks");
    });

    it("binds environment_id", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.create({ ...sampleRow, environment_id: "env_abc" });

      expect(statements[0].sql).toContain("environment_id");
      expect(statements[0].params[statements[0].params.length - 1]).toBe("env_abc");
    });
  });

  describe("update", () => {
    it("writes only whitelisted fields", async () => {
      const { db, statements } = createFakeD1({ firstResult: sampleRow });
      const store = new AutomationStore(db);

      await store.update(sampleRow.id, { name: "Renamed" });

      const updateStatement = statements.find((s) => s.sql.includes("UPDATE automations SET"));
      expect(updateStatement).toBeDefined();
      expect(updateStatement!.sql).toContain("name = ?");
      expect(updateStatement!.sql).not.toContain("repo_owner");
    });

    it("writes environment_id, including clearing to null", async () => {
      const { db, statements } = createFakeD1({ firstResult: sampleRow });
      const store = new AutomationStore(db);

      await store.update(sampleRow.id, { environment_id: null });

      const updateStatement = statements.find((s) => s.sql.includes("UPDATE automations SET"));
      expect(updateStatement).toBeDefined();
      expect(updateStatement!.sql).toContain("environment_id = ?");
      expect(updateStatement!.params[0]).toBeNull();
    });
  });

  describe("getById", () => {
    it("returns row when found", async () => {
      const { db } = createFakeD1({ firstResult: sampleRow });
      const store = new AutomationStore(db);
      const result = await store.getById("auto_test1");
      expect(result).toEqual(sampleRow);
    });

    it("returns null when not found", async () => {
      const { db } = createFakeD1({ firstResult: null });
      const store = new AutomationStore(db);
      const result = await store.getById("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("returns automations and total", async () => {
      const { db } = createFakeD1({
        allResults: [sampleRow],
      });
      const store = new AutomationStore(db);
      const result = await store.list();
      expect(result.total).toBe(1);
      expect(result.automations).toHaveLength(1);
    });
  });

  describe("softDelete", () => {
    it("sets deleted_at and returns true", async () => {
      const { db, statements } = createFakeD1({ changes: 1 });
      const store = new AutomationStore(db);
      const result = await store.softDelete("auto_test1");
      expect(result).toBe(true);
      expect(statements[0].sql).toContain("deleted_at");
      expect(statements[0].sql).toContain("next_run_at = NULL");
    });

    it("returns false when automation not found", async () => {
      const { db } = createFakeD1({ changes: 0 });
      const store = new AutomationStore(db);
      const result = await store.softDelete("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("pause", () => {
    it("sets enabled=0 and nulls next_run_at", async () => {
      const { db, statements } = createFakeD1({ changes: 1 });
      const store = new AutomationStore(db);
      const result = await store.pause("auto_test1");
      expect(result).toBe(true);
      expect(statements[0].sql).toContain("enabled = 0");
      expect(statements[0].sql).toContain("next_run_at = NULL");
    });
  });

  describe("resume", () => {
    it("sets enabled=1, resets failures, sets next_run_at", async () => {
      const { db, statements } = createFakeD1({ changes: 1 });
      const store = new AutomationStore(db);
      const nextRunAt = now + 86400000;
      const result = await store.resume("auto_test1", nextRunAt);
      expect(result).toBe(true);
      expect(statements[0].sql).toContain("enabled = 1");
      expect(statements[0].sql).toContain("consecutive_failures = 0");
      expect(statements[0].params).toContain(nextRunAt);
    });
  });

  describe("countOverdue", () => {
    it("returns count of overdue automations", async () => {
      const { db } = createFakeD1({ firstResult: { count: 3 } });
      const store = new AutomationStore(db);
      const result = await store.countOverdue(now);
      expect(result).toBe(3);
    });
  });

  describe("getOverdueAutomations", () => {
    it("returns overdue automations ordered by next_run_at", async () => {
      const { db, statements } = createFakeD1({
        allResults: [sampleRow],
      });
      const store = new AutomationStore(db);
      const result = await store.getOverdueAutomations(now, 25);
      expect(result).toHaveLength(1);
      expect(statements[0].sql).toContain("ORDER BY next_run_at ASC");
      expect(statements[0].params).toContain(25);
    });
  });

  describe("getActiveRunForAutomation", () => {
    it("returns active run", async () => {
      const { db } = createFakeD1({ firstResult: sampleRunRow });
      const store = new AutomationStore(db);
      const result = await store.getActiveRunForAutomation("auto_test1");
      expect(result).toEqual(sampleRunRow);
    });

    it("returns null when no active run", async () => {
      const { db } = createFakeD1({ firstResult: null });
      const store = new AutomationStore(db);
      const result = await store.getActiveRunForAutomation("auto_test1");
      expect(result).toBeNull();
    });
  });

  describe("incrementConsecutiveFailures", () => {
    it("increments and returns new count", async () => {
      const fakeStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({
          results: [],
          success: true,
          meta: { duration: 0, changes: 1 },
        }),
        first: vi.fn().mockResolvedValue({ consecutive_failures: 2 }),
        all: vi.fn(),
      };

      const db = {
        prepare: vi.fn().mockReturnValue(fakeStmt),
      } as unknown as D1Database;

      const store = new AutomationStore(db);
      const count = await store.incrementConsecutiveFailures("auto_test1");
      expect(count).toBe(2);
    });
  });

  describe("autoPause", () => {
    it("sets enabled=0 and nulls next_run_at", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.autoPause("auto_test1");

      expect(statements[0].sql).toContain("enabled = 0");
      expect(statements[0].sql).toContain("next_run_at = NULL");
    });
  });

  describe("getOrphanedStartingRuns", () => {
    it("returns runs stuck in starting state", async () => {
      const { db, statements } = createFakeD1({
        allResults: [sampleRunRow],
      });
      const store = new AutomationStore(db);
      const result = await store.getOrphanedStartingRuns(5 * 60 * 1000, 50);
      expect(result).toHaveLength(1);
      expect(statements[0].sql).toContain("status = 'starting'");
    });
  });

  describe("getTimedOutRunningRuns", () => {
    it("returns runs stuck in running state", async () => {
      const { db, statements } = createFakeD1({
        allResults: [{ ...sampleRunRow, status: "running", started_at: now }],
      });
      const store = new AutomationStore(db);
      const result = await store.getTimedOutRunningRuns(90 * 60 * 1000, 50);
      expect(result).toHaveLength(1);
      expect(statements[0].sql).toContain("status = 'running'");
    });
  });

  describe("updateRun", () => {
    it("updates specified fields", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.updateRun("run_test1", {
        status: "running",
        session_id: "sess-1",
        started_at: now,
      });

      expect(statements[0].sql).toContain("UPDATE automation_runs");
      expect(statements[0].sql).toContain("status = ?");
      expect(statements[0].sql).toContain("session_id = ?");
      expect(statements[0].sql).toContain("started_at = ?");
    });

    it("skips update when no fields provided", async () => {
      const { db, statements } = createFakeD1();
      const store = new AutomationStore(db);
      await store.updateRun("run_test1", {});
      expect(statements).toHaveLength(0);
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
