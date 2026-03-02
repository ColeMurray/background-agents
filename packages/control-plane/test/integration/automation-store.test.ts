import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  toAutomation,
  toAutomationRun,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    enabled: 1,
    next_run_at: now + 86400000,
    consecutive_failures: 0,
    created_by: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

function makeRun(automationId: string, overrides?: Partial<AutomationRunRow>): AutomationRunRow {
  const now = Date.now();
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    automation_id: automationId,
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: now,
    started_at: null,
    completed_at: null,
    created_at: now,
    ...overrides,
  };
}

describe("AutomationStore (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("creates and retrieves an automation", async () => {
      const store = new AutomationStore(env.DB);
      const row = makeAutomation({ id: "auto-1", name: "Daily sync" });
      await store.create(row);

      const result = await store.getById("auto-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("auto-1");
      expect(result!.name).toBe("Daily sync");
      expect(result!.repo_owner).toBe("acme");
      expect(result!.repo_name).toBe("web-app");
      expect(result!.base_branch).toBe("main");
      expect(result!.trigger_type).toBe("schedule");
      expect(result!.schedule_cron).toBe("0 9 * * *");
      expect(result!.enabled).toBe(1);
      expect(result!.consecutive_failures).toBe(0);
    });

    it("returns null for nonexistent automation", async () => {
      const store = new AutomationStore(env.DB);
      const result = await store.getById("nonexistent");
      expect(result).toBeNull();
    });

    it("updates allowed fields", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-2" }));

      const updated = await store.update("auto-2", {
        name: "Updated Name",
        instructions: "Updated instructions",
        schedule_cron: "0 10 * * *",
        model: "anthropic/claude-haiku-4-5",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Name");
      expect(updated!.instructions).toBe("Updated instructions");
      expect(updated!.schedule_cron).toBe("0 10 * * *");
      expect(updated!.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("soft-deletes an automation", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-3" }));

      const deleted = await store.softDelete("auto-3");
      expect(deleted).toBe(true);

      const result = await store.getById("auto-3");
      expect(result).toBeNull();
    });

    it("soft-delete returns false for nonexistent", async () => {
      const store = new AutomationStore(env.DB);
      const deleted = await store.softDelete("nonexistent");
      expect(deleted).toBe(false);
    });

    it("toAutomation maps row to camelCase", async () => {
      const store = new AutomationStore(env.DB);
      const row = makeAutomation({ id: "auto-map", enabled: 1, consecutive_failures: 2 });
      await store.create(row);

      const dbRow = (await store.getById("auto-map"))!;
      const automation = toAutomation(dbRow);
      expect(automation.repoOwner).toBe("acme");
      expect(automation.repoName).toBe("web-app");
      expect(automation.baseBranch).toBe("main");
      expect(automation.scheduleCron).toBe("0 9 * * *");
      expect(automation.enabled).toBe(true);
      expect(automation.consecutiveFailures).toBe(2);
      expect(automation.createdBy).toBe("user-1");
    });
  });

  // ─── List ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists all automations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-a", name: "First" }));
      await store.create(makeAutomation({ id: "auto-b", name: "Second" }));

      const result = await store.list();
      expect(result.total).toBe(2);
      expect(result.automations).toHaveLength(2);
    });

    it("filters by repo owner and name", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-c", repo_owner: "acme", repo_name: "api" }));
      await store.create(makeAutomation({ id: "auto-d", repo_owner: "acme", repo_name: "web" }));

      const result = await store.list({ repoOwner: "acme", repoName: "api" });
      expect(result.total).toBe(1);
      expect(result.automations[0].id).toBe("auto-c");
    });

    it("excludes soft-deleted automations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-e" }));
      await store.softDelete("auto-e");

      const result = await store.list();
      expect(result.total).toBe(0);
    });

    it("orders by created_at DESC", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-old", created_at: now - 2000 }));
      await store.create(makeAutomation({ id: "auto-new", created_at: now }));

      const result = await store.list();
      expect(result.automations[0].id).toBe("auto-new");
      expect(result.automations[1].id).toBe("auto-old");
    });
  });

  // ─── Pause / Resume ────────────────────────────────────────────────────────

  describe("pause and resume", () => {
    it("pauses an automation (disables + clears next_run_at)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({ id: "auto-p1", enabled: 1, next_run_at: Date.now() + 86400000 })
      );

      const paused = await store.pause("auto-p1");
      expect(paused).toBe(true);

      const row = await store.getById("auto-p1");
      expect(row!.enabled).toBe(0);
      expect(row!.next_run_at).toBeNull();
    });

    it("resumes an automation (enables + sets next_run_at + resets failures)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({ id: "auto-p2", enabled: 0, next_run_at: null, consecutive_failures: 2 })
      );

      const nextRunAt = Date.now() + 3600000;
      const resumed = await store.resume("auto-p2", nextRunAt);
      expect(resumed).toBe(true);

      const row = await store.getById("auto-p2");
      expect(row!.enabled).toBe(1);
      expect(row!.next_run_at).toBe(nextRunAt);
      expect(row!.consecutive_failures).toBe(0);
    });
  });

  // ─── Overdue queries ───────────────────────────────────────────────────────

  describe("overdue queries", () => {
    it("counts overdue automations", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      // Overdue + enabled
      await store.create(makeAutomation({ id: "auto-o1", next_run_at: now - 60000, enabled: 1 }));
      // Not yet due
      await store.create(makeAutomation({ id: "auto-o2", next_run_at: now + 60000, enabled: 1 }));
      // Overdue but disabled
      await store.create(makeAutomation({ id: "auto-o3", next_run_at: now - 120000, enabled: 0 }));

      const count = await store.countOverdue(now);
      expect(count).toBe(1);
    });

    it("gets overdue automations ordered by next_run_at ASC", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-o4", next_run_at: now - 30000, enabled: 1 }));
      await store.create(makeAutomation({ id: "auto-o5", next_run_at: now - 60000, enabled: 1 }));

      const overdue = await store.getOverdueAutomations(now, 10);
      expect(overdue).toHaveLength(2);
      expect(overdue[0].id).toBe("auto-o5"); // Older first
      expect(overdue[1].id).toBe("auto-o4");
    });

    it("respects limit", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-o6", next_run_at: now - 60000, enabled: 1 }));
      await store.create(makeAutomation({ id: "auto-o7", next_run_at: now - 30000, enabled: 1 }));

      const overdue = await store.getOverdueAutomations(now, 1);
      expect(overdue).toHaveLength(1);
    });

    it("excludes non-schedule trigger types", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(
        makeAutomation({
          id: "auto-o8",
          next_run_at: now - 60000,
          enabled: 1,
          trigger_type: "manual",
        })
      );

      const count = await store.countOverdue(now);
      expect(count).toBe(0);
    });
  });

  // ─── Run management ────────────────────────────────────────────────────────

  describe("run management", () => {
    it("creates a run and advances schedule atomically", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r1", next_run_at: now - 60000 }));

      const nextRunAt = now + 86400000;
      const run = makeRun("auto-r1", {
        id: "run-1",
        scheduled_at: now - 60000,
        created_at: now,
      });

      await store.createRunAndAdvanceSchedule(run, "auto-r1", nextRunAt);

      // Verify run was created
      const runs = await store.listRunsForAutomation("auto-r1", { limit: 10, offset: 0 });
      expect(runs.total).toBe(1);
      expect(runs.runs[0].id).toBe("run-1");
      expect(runs.runs[0].status).toBe("starting");

      // Verify schedule was advanced
      const automation = await store.getById("auto-r1");
      expect(automation!.next_run_at).toBe(nextRunAt);
    });

    it("inserts a run (e.g. skipped)", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r2" }));

      await store.insertRun(
        makeRun("auto-r2", {
          id: "run-skip-1",
          status: "skipped",
          skip_reason: "concurrent_run_active",
          completed_at: now,
        })
      );

      const runs = await store.listRunsForAutomation("auto-r2", { limit: 10, offset: 0 });
      expect(runs.total).toBe(1);
      expect(runs.runs[0].status).toBe("skipped");
      expect(runs.runs[0].skip_reason).toBe("concurrent_run_active");
    });

    it("updates a run's status and fields", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r3" }));

      await store.insertRun(makeRun("auto-r3", { id: "run-u1", status: "starting" }));

      await store.updateRun("run-u1", {
        status: "running",
        session_id: "sess-1",
        started_at: now + 1000,
      });

      const run = await store.getRunById("auto-r3", "run-u1");
      expect(run).not.toBeNull();
      expect(run!.status).toBe("running");
      expect(run!.session_id).toBe("sess-1");
      expect(run!.started_at).toBe(now + 1000);
    });

    it("detects active runs (starting or running)", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r4" }));

      // No active run initially
      let active = await store.getActiveRunForAutomation("auto-r4");
      expect(active).toBeNull();

      // Create a running run
      await store.insertRun(
        makeRun("auto-r4", {
          id: "run-active-1",
          status: "running",
          session_id: "sess-1",
          started_at: now,
        })
      );

      active = await store.getActiveRunForAutomation("auto-r4");
      expect(active).not.toBeNull();
      expect(active!.id).toBe("run-active-1");
    });

    it("does not count completed runs as active", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r5" }));

      await store.insertRun(
        makeRun("auto-r5", { id: "run-done-1", status: "completed", completed_at: now })
      );

      const active = await store.getActiveRunForAutomation("auto-r5");
      expect(active).toBeNull();
    });

    it("lists runs with pagination", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r6" }));

      for (let i = 0; i < 3; i++) {
        await store.insertRun(
          makeRun("auto-r6", {
            id: `run-page-${i}`,
            status: "completed",
            scheduled_at: now + i * 1000, // unique per idempotency index
            completed_at: now,
            created_at: now + i,
          })
        );
      }

      const page1 = await store.listRunsForAutomation("auto-r6", { limit: 2, offset: 0 });
      expect(page1.total).toBe(3);
      expect(page1.runs).toHaveLength(2);

      const page2 = await store.listRunsForAutomation("auto-r6", { limit: 2, offset: 2 });
      expect(page2.total).toBe(3);
      expect(page2.runs).toHaveLength(1);
    });

    it("getRunById returns enriched run with session title", async () => {
      const store = new AutomationStore(env.DB);
      const sessionStore = new SessionIndexStore(env.DB);
      const now = Date.now();

      await store.create(makeAutomation({ id: "auto-r7" }));

      // Create a session
      await sessionStore.create({
        id: "sess-enriched",
        title: "Auto Session Title",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "completed",
        createdAt: now,
        updatedAt: now,
      });

      await store.insertRun(
        makeRun("auto-r7", {
          id: "run-enriched",
          session_id: "sess-enriched",
          status: "completed",
          completed_at: now,
        })
      );

      const run = await store.getRunById("auto-r7", "run-enriched");
      expect(run).not.toBeNull();
      expect(run!.session_title).toBe("Auto Session Title");

      // toAutomationRun mapper
      const mapped = toAutomationRun(run!);
      expect(mapped.sessionTitle).toBe("Auto Session Title");
      expect(mapped.sessionId).toBe("sess-enriched");
    });
  });

  // ─── Recovery sweep queries ────────────────────────────────────────────────

  describe("recovery sweep queries", () => {
    it("finds orphaned starting runs older than threshold", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec1" }));

      const tenMinutesAgo = now - 10 * 60 * 1000;
      await store.insertRun(
        makeRun("auto-rec1", {
          id: "run-orphan-1",
          status: "starting",
          scheduled_at: tenMinutesAgo,
          created_at: tenMinutesAgo,
        })
      );

      const orphaned = await store.getOrphanedStartingRuns(5 * 60 * 1000);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].id).toBe("run-orphan-1");
    });

    it("does not find recent starting runs", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec2" }));

      await store.insertRun(
        makeRun("auto-rec2", { id: "run-recent-1", status: "starting", created_at: now })
      );

      const orphaned = await store.getOrphanedStartingRuns(5 * 60 * 1000);
      expect(orphaned).toHaveLength(0);
    });

    it("finds timed-out running runs older than threshold", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec3" }));

      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      await store.insertRun(
        makeRun("auto-rec3", {
          id: "run-timeout-1",
          status: "running",
          session_id: "sess-t1",
          scheduled_at: twoHoursAgo,
          started_at: twoHoursAgo,
          created_at: twoHoursAgo,
        })
      );

      const timedOut = await store.getTimedOutRunningRuns(90 * 60 * 1000);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].id).toBe("run-timeout-1");
    });

    it("does not find recent running runs", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec4" }));

      await store.insertRun(
        makeRun("auto-rec4", {
          id: "run-recent-running",
          status: "running",
          started_at: now,
          created_at: now,
        })
      );

      const timedOut = await store.getTimedOutRunningRuns(90 * 60 * 1000);
      expect(timedOut).toHaveLength(0);
    });
  });

  // ─── Failure tracking ──────────────────────────────────────────────────────

  describe("failure tracking", () => {
    it("increments consecutive failures", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-f1", consecutive_failures: 0 }));

      const count1 = await store.incrementConsecutiveFailures("auto-f1");
      expect(count1).toBe(1);

      const count2 = await store.incrementConsecutiveFailures("auto-f1");
      expect(count2).toBe(2);

      const count3 = await store.incrementConsecutiveFailures("auto-f1");
      expect(count3).toBe(3);
    });

    it("resets consecutive failures to zero", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-f2", consecutive_failures: 5 }));

      await store.resetConsecutiveFailures("auto-f2");

      const row = await store.getById("auto-f2");
      expect(row!.consecutive_failures).toBe(0);
    });

    it("auto-pauses automation (disables + clears next_run_at)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({ id: "auto-f3", enabled: 1, next_run_at: Date.now() + 86400000 })
      );

      await store.autoPause("auto-f3");

      const row = await store.getById("auto-f3");
      expect(row!.enabled).toBe(0);
      expect(row!.next_run_at).toBeNull();
    });
  });
});
