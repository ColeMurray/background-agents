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
import { seedRun, fetchRuns } from "./run-helpers";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    instructions: "Run tests",
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
    invocation_id: null,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    ...overrides,
  };
}

/**
 * Seed a run linked to an event invocation that carries the concurrency key —
 * the shape the overlap/steer queries read (firing keys live on the invocation).
 */
async function seedRunForKey(
  automationId: string,
  concurrencyKey: string | null,
  run: Partial<AutomationRunRow> & { id: string }
): Promise<void> {
  const now = Date.now();
  const invocationId = `inv-${run.id}`;
  await env.DB.prepare(
    `INSERT INTO automation_invocations
       (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
        trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
     VALUES (?, ?, 'event', NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`
  )
    .bind(invocationId, automationId, concurrencyKey, run.created_at ?? now, now)
    .run();
  await seedRun(makeRun(automationId, { ...run, invocation_id: invocationId }));
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
      expect(result!.trigger_type).toBe("schedule");
      expect(result!.schedule_cron).toBe("0 9 * * *");
      expect(result!.enabled).toBe(1);
      expect(result!.consecutive_failures).toBe(0);
    });

    it("stores and retrieves user_id", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-uid", user_id: "canonical-user-1" }));

      const result = await store.getById("auto-uid");
      expect(result).not.toBeNull();
      expect(result!.user_id).toBe("canonical-user-1");
    });

    it("defaults user_id to null when omitted", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-uid-null" }));

      const result = await store.getById("auto-uid-null");
      expect(result).not.toBeNull();
      expect(result!.user_id).toBeNull();
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

    it("advanceNextRunAt only moves the schedule forward", async () => {
      const store = new AutomationStore(env.DB);
      const base = 1_000_000_000_000;
      await store.create(makeAutomation({ id: "auto-adv", next_run_at: base }));

      // An earlier time is rejected — a stale duplicate must not rewind the
      // schedule (which would leave the automation spuriously overdue).
      const rewound = await store.advanceNextRunAt("auto-adv", base - 60_000);
      expect(rewound).toBe(false);
      expect((await store.getById("auto-adv"))!.next_run_at).toBe(base);

      // A strictly later time advances it.
      const advanced = await store.advanceNextRunAt("auto-adv", base + 60_000);
      expect(advanced).toBe(true);
      expect((await store.getById("auto-adv"))!.next_run_at).toBe(base + 60_000);
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
      const row = makeAutomation({
        id: "auto-map",
        enabled: 1,
        consecutive_failures: 2,
        reasoning_effort: "high",
      });
      await store.create(row);

      const dbRow = (await store.getById("auto-map"))!;
      const automation = toAutomation(dbRow, []);
      expect(automation.repositories).toEqual([]);
      expect(automation.scheduleCron).toBe("0 9 * * *");
      expect(automation.reasoningEffort).toBe("high");
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

    it("filters by repo owner and name via repository rows", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-c", repo_owner: "acme", repo_name: "api" }));
      await store.replaceRepositories("auto-c", [
        { repo_owner: "acme", repo_name: "api", repo_id: 1, base_branch: null },
      ]);
      await store.create(makeAutomation({ id: "auto-d", repo_owner: "acme", repo_name: "web" }));
      await store.replaceRepositories("auto-d", [
        { repo_owner: "acme", repo_name: "web", repo_id: 2, base_branch: null },
      ]);

      const result = await store.list({ repoOwner: "acme", repoName: "api" });
      expect(result.total).toBe(1);
      expect(result.automations[0].id).toBe("auto-c");
    });

    it("matches multi-repository automations on any selected repository", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({
          id: "auto-multi",
          repo_owner: null,
          repo_name: null,
          base_branch: null,
          repo_id: null,
        })
      );
      await store.replaceRepositories("auto-multi", [
        { repo_owner: "acme", repo_name: "api", repo_id: 1, base_branch: null },
        { repo_owner: "acme", repo_name: "web", repo_id: 2, base_branch: "develop" },
      ]);

      const byApi = await store.list({ repoOwner: "acme", repoName: "api" });
      expect(byApi.automations.map((a) => a.id)).toEqual(["auto-multi"]);
      const byWeb = await store.list({ repoOwner: "acme", repoName: "web" });
      expect(byWeb.automations.map((a) => a.id)).toEqual(["auto-multi"]);
      const byOther = await store.list({ repoOwner: "acme", repoName: "other" });
      expect(byOther.total).toBe(0);
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
    it("round-trips a legacy-shaped skipped row (rollback-window shape)", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r2" }));

      await seedRun(
        makeRun("auto-r2", {
          id: "run-skip-1",
          status: "skipped",
          skip_reason: "concurrent_run_active",
          completed_at: now,
        })
      );

      const runs = await fetchRuns("auto-r2");
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("skipped");
      expect(runs[0].skip_reason).toBe("concurrent_run_active");
    });

    it("updates a run's status and fields", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-r3" }));

      await seedRun(makeRun("auto-r3", { id: "run-u1", status: "starting" }));

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
      await seedRun(
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

      await seedRun(
        makeRun("auto-r5", { id: "run-done-1", status: "completed", completed_at: now })
      );

      const active = await store.getActiveRunForAutomation("auto-r5");
      expect(active).toBeNull();
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

      await seedRun(
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
      await seedRun(
        makeRun("auto-rec1", {
          id: "run-orphan-1",
          status: "starting",
          scheduled_at: tenMinutesAgo,
          created_at: tenMinutesAgo,
        })
      );

      const orphaned = await store.getOrphanedStartingRuns(5 * 60 * 1000, 50);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].id).toBe("run-orphan-1");
    });

    it("does not find recent starting runs", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec2" }));

      await seedRun(
        makeRun("auto-rec2", { id: "run-recent-1", status: "starting", created_at: now })
      );

      const orphaned = await store.getOrphanedStartingRuns(5 * 60 * 1000, 50);
      expect(orphaned).toHaveLength(0);
    });

    it("finds timed-out running runs older than threshold", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec3" }));

      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      await seedRun(
        makeRun("auto-rec3", {
          id: "run-timeout-1",
          status: "running",
          session_id: "sess-t1",
          scheduled_at: twoHoursAgo,
          started_at: twoHoursAgo,
          created_at: twoHoursAgo,
        })
      );

      const timedOut = await store.getTimedOutRunningRuns(90 * 60 * 1000, 50);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].id).toBe("run-timeout-1");
    });

    it("does not find recent running runs", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rec4" }));

      await seedRun(
        makeRun("auto-rec4", {
          id: "run-recent-running",
          status: "running",
          started_at: now,
          created_at: now,
        })
      );

      const timedOut = await store.getTimedOutRunningRuns(90 * 60 * 1000, 50);
      expect(timedOut).toHaveLength(0);
    });

    it("drains oldest orphaned runs first when LIMIT is hit", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-order1" }));

      const base = now - 60 * 60 * 1000;
      for (let i = 0; i < 5; i++) {
        await seedRun(
          makeRun("auto-order1", {
            id: `run-order-${i}`,
            status: "starting",
            scheduled_at: base + i * 1000,
            created_at: base + i * 1000,
          })
        );
      }

      const orphaned = await store.getOrphanedStartingRuns(5 * 60 * 1000, 3);
      expect(orphaned).toHaveLength(3);
      expect(orphaned.map((r) => r.id)).toEqual(["run-order-0", "run-order-1", "run-order-2"]);
    });

    it("drains oldest timed-out runs first when LIMIT is hit", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-order2" }));

      const base = now - 3 * 60 * 60 * 1000;
      for (let i = 0; i < 5; i++) {
        await seedRun(
          makeRun("auto-order2", {
            id: `run-to-${i}`,
            status: "running",
            session_id: `sess-${i}`,
            scheduled_at: base + i * 1000,
            started_at: base + i * 1000,
            created_at: base + i * 1000,
          })
        );
      }

      const timedOut = await store.getTimedOutRunningRuns(90 * 60 * 1000, 3);
      expect(timedOut).toHaveLength(3);
      expect(timedOut.map((r) => r.id)).toEqual(["run-to-0", "run-to-1", "run-to-2"]);
    });

    // The behavioural tests above pass with or without the index (a scan returns
    // the same rows); these EXPLAIN the real production SQL to assert the partial
    // index is actually used.
    it("orphan sweep is served by idx_runs_orphan_sweep, not a full scan", async () => {
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${AutomationStore.ORPHANED_STARTING_RUNS_SQL}`
      )
        .bind(Date.now())
        .all<{ detail: string }>();
      const detail = plan.results.map((r) => r.detail).join("\n");
      expect(detail).toContain("USING INDEX idx_runs_orphan_sweep");
    });

    it("timeout sweep is served by idx_runs_timeout_sweep, not a full scan", async () => {
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${AutomationStore.TIMED_OUT_RUNNING_RUNS_SQL}`
      )
        .bind(Date.now())
        .all<{ detail: string }>();
      const detail = plan.results.map((r) => r.detail).join("\n");
      expect(detail).toContain("USING INDEX idx_runs_timeout_sweep");
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

  // ─── Event matching queries ───────────────────────────────────────────────

  describe("event matching queries", () => {
    it("getAutomationsForEvent finds matching automations by repo + trigger type + event type", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({
          id: "auto-ev1",
          repo_owner: "acme",
          repo_name: "api",
          trigger_type: "github_event",
          event_type: "pull_request.opened",
        })
      );
      await store.replaceRepositories("auto-ev1", [
        { repo_owner: "acme", repo_name: "api", repo_id: 1, base_branch: null },
      ]);
      await store.create(
        makeAutomation({
          id: "auto-ev2",
          repo_owner: "acme",
          repo_name: "api",
          trigger_type: "github_event",
          event_type: "issues.opened",
        })
      );
      await store.replaceRepositories("auto-ev2", [
        { repo_owner: "acme", repo_name: "api", repo_id: 1, base_branch: null },
      ]);

      const results = await store.getAutomationsForEvent(
        "acme",
        "api",
        "github_event",
        "pull_request.opened"
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("auto-ev1");
    });

    it("getAutomationsForEvent excludes disabled and deleted automations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(
        makeAutomation({
          id: "auto-ev3",
          repo_owner: "acme",
          repo_name: "api",
          trigger_type: "github_event",
          event_type: "pull_request.opened",
          enabled: 0,
        })
      );

      const results = await store.getAutomationsForEvent(
        "acme",
        "api",
        "github_event",
        "pull_request.opened"
      );
      expect(results).toHaveLength(0);
    });

    it("getActiveRunForKey finds active run by concurrency key", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-ck1" }));

      await seedRunForKey("auto-ck1", "pr:42", {
        id: "run-ck1",
        status: "running",
        started_at: Date.now(),
      });

      const active = await store.getActiveRunForKey("auto-ck1", "pr:42");
      expect(active).not.toBeNull();
      expect(active!.id).toBe("run-ck1");
    });

    it("getActiveRunForKey returns null for different concurrency key", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-ck2" }));

      await seedRunForKey("auto-ck2", "pr:42", {
        id: "run-ck2",
        status: "running",
        started_at: Date.now(),
      });

      const active = await store.getActiveRunForKey("auto-ck2", "pr:99");
      expect(active).toBeNull();
    });

    it("getActiveRunForKey with null key falls back to getActiveRunForAutomation", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-ck3" }));

      await seedRun(
        makeRun("auto-ck3", {
          id: "run-ck3",
          status: "running",
          concurrency_key: null,
          started_at: Date.now(),
        })
      );

      const active = await store.getActiveRunForKey("auto-ck3", null);
      expect(active).not.toBeNull();
      expect(active!.id).toBe("run-ck3");
    });

    it("getLatestSteerableRunForThread finds a completed run with a session (any status)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-steer1" }));

      await seedRunForKey("auto-steer1", "slack:C1:t1", {
        id: "run-steer1",
        status: "completed",
        session_id: "sess-1",
        completed_at: Date.now(),
      });

      const run = await store.getLatestSteerableRunForThread("auto-steer1", "slack:C1:t1", 0);
      expect(run).not.toBeNull();
      expect(run!.id).toBe("run-steer1");
    });

    it("getLatestSteerableRunForThread excludes runs without a session", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-steer2" }));

      // A skip/starting row (session_id null) must not shadow the thread session.
      await seedRunForKey("auto-steer2", "slack:C1:t2", {
        id: "run-steer2-skip",
        status: "skipped",
        session_id: null,
      });

      const run = await store.getLatestSteerableRunForThread("auto-steer2", "slack:C1:t2", 0);
      expect(run).toBeNull();
    });

    it("getLatestSteerableRunForThread excludes runs created before the window", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-steer3" }));

      await seedRunForKey("auto-steer3", "slack:C1:t3", {
        id: "run-steer3-old",
        status: "completed",
        session_id: "sess-old",
        created_at: Date.now() - 48 * 60 * 60 * 1000,
      });

      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      const run = await store.getLatestSteerableRunForThread("auto-steer3", "slack:C1:t3", sinceMs);
      expect(run).toBeNull();
    });

    it("getLatestSteerableRunForThread returns the most recent session run for the key", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-steer4" }));

      await seedRunForKey("auto-steer4", "slack:C1:t4", {
        id: "run-steer4-older",
        status: "completed",
        session_id: "sess-older",
        scheduled_at: Date.now() - 60000,
        created_at: Date.now() - 60000,
      });
      await seedRunForKey("auto-steer4", "slack:C1:t4", {
        id: "run-steer4-newer",
        status: "running",
        session_id: "sess-newer",
        scheduled_at: Date.now(),
        created_at: Date.now(),
      });

      const run = await store.getLatestSteerableRunForThread("auto-steer4", "slack:C1:t4", 0);
      expect(run!.id).toBe("run-steer4-newer");
    });

    it("getLatestSteerableRunForThread returns null for a null concurrency key", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-steer5" }));
      const run = await store.getLatestSteerableRunForThread("auto-steer5", null, 0);
      expect(run).toBeNull();
    });
  });
});
