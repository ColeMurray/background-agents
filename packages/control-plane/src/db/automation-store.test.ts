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
  repo_owner: "acme",
  repo_name: "web-app",
  base_branch: "main",
  repo_id: 12345,
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
  completed_at: null,
  created_at: now,
  trigger_key: null,
  concurrency_key: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("toAutomation", () => {
  it("converts row to camelCase Automation", () => {
    const automation = toAutomation(sampleRow);
    expect(automation.id).toBe("auto_test1");
    expect(automation.repoOwner).toBe("acme");
    expect(automation.repoName).toBe("web-app");
    expect(automation.baseBranch).toBe("main");
    expect(automation.scheduleCron).toBe("0 9 * * *");
    expect(automation.scheduleTz).toBe("UTC");
    expect(automation.reasoningEffort).toBeNull();
    expect(automation.enabled).toBe(true);
    expect(automation.triggerType).toBe("schedule");
    expect(automation.eventType).toBeNull();
    expect(automation.triggerConfig).toBeNull();
    expect(automation.consecutiveFailures).toBe(0);
    expect(automation.createdBy).toBe("user-1");
  });

  it("converts enabled=0 to false", () => {
    const automation = toAutomation({ ...sampleRow, enabled: 0 });
    expect(automation.enabled).toBe(false);
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
    expect(run.triggerKey).toBeNull();
    expect(run.concurrencyKey).toBeNull();
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

  describe("createRunAndAdvanceSchedule", () => {
    it("calls db.batch with insert and update", async () => {
      const batchSpy = vi.fn().mockResolvedValue([
        { results: [], success: true, meta: { duration: 0, changes: 1 } },
        { results: [], success: true, meta: { duration: 0, changes: 1 } },
      ]);

      const fakeStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn(),
        first: vi.fn(),
        all: vi.fn(),
      };

      const db = {
        prepare: vi.fn().mockReturnValue(fakeStmt),
        batch: batchSpy,
      } as unknown as D1Database;

      const store = new AutomationStore(db);
      const nextRunAt = now + 86400000;

      await store.createRunAndAdvanceSchedule(sampleRunRow, "auto_test1", nextRunAt);

      expect(batchSpy).toHaveBeenCalledTimes(1);
      // Two statements: INSERT run + UPDATE automation
      expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
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
      const result = await store.getOrphanedStartingRuns(5 * 60 * 1000);
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
      const result = await store.getTimedOutRunningRuns(90 * 60 * 1000);
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

  describe("listRunsForAutomation", () => {
    it("returns runs with enriched data", async () => {
      const enrichedRow: EnrichedRunRow = {
        ...sampleRunRow,
        session_title: "Auto session",
        artifact_summary: "1 artifacts",
      };

      const fakeStmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ count: 1 }),
        all: vi.fn().mockResolvedValue({
          results: [enrichedRow],
          success: true,
          meta: { duration: 0 },
        }),
        run: vi.fn(),
      };

      const db = {
        prepare: vi.fn().mockReturnValue(fakeStmt),
      } as unknown as D1Database;

      const store = new AutomationStore(db);
      const result = await store.listRunsForAutomation("auto_test1", {
        limit: 20,
        offset: 0,
      });

      expect(result.total).toBe(1);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].session_title).toBe("Auto session");
    });
  });
});
