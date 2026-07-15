import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";
import { makeRunRow, seedRun, fetchRuns } from "./run-helpers";

function getSchedulerStub() {
  const id = env.SCHEDULER.idFromName("global-scheduler");
  return env.SCHEDULER.get(id);
}

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

describe("SchedulerDO (integration)", () => {
  beforeEach(cleanD1Tables);

  // ─── Health check ─────────────────────────────────────────────────────────

  describe("/internal/health", () => {
    it("returns healthy with overdue count", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-h1", next_run_at: now - 60000, enabled: 1 }));
      await store.create(makeAutomation({ id: "auto-h2", next_run_at: now + 60000, enabled: 1 }));

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/health", { method: "GET" });

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string; overdueCount: number }>();
      expect(body.status).toBe("healthy");
      expect(body.overdueCount).toBe(1);
    });

    it("returns zero overdue when none are due", async () => {
      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/health", { method: "GET" });

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string; overdueCount: number }>();
      expect(body.overdueCount).toBe(0);
    });
  });

  // ─── Run complete callback ────────────────────────────────────────────────

  describe("/internal/run-complete", () => {
    it("marks run as completed and resets failures on success", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rc1", consecutive_failures: 2 }));

      await seedRun(
        makeRunRow("auto-rc1", {
          id: "run-rc1",
          session_id: "sess-1",
          status: "running",
          started_at: now,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "auto-rc1",
          runId: "run-rc1",
          sessionId: "sess-1",
          success: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);

      // Verify run status
      const run = await store.getRunById("auto-rc1", "run-rc1");
      expect(run!.status).toBe("completed");
      expect(run!.completed_at).not.toBeNull();

      // Verify consecutive failures were reset
      const automation = await store.getById("auto-rc1");
      expect(automation!.consecutive_failures).toBe(0);
    });

    it("marks run as failed and increments failures on failure", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rc2", consecutive_failures: 0 }));

      await seedRun(
        makeRunRow("auto-rc2", {
          id: "run-rc2",
          session_id: "sess-2",
          status: "running",
          started_at: now,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "auto-rc2",
          runId: "run-rc2",
          sessionId: "sess-2",
          success: false,
          error: "Sandbox crashed",
        }),
      });

      expect(res.status).toBe(200);

      const run = await store.getRunById("auto-rc2", "run-rc2");
      expect(run!.status).toBe("failed");
      expect(run!.failure_reason).toBe("Sandbox crashed");

      const automation = await store.getById("auto-rc2");
      expect(automation!.consecutive_failures).toBe(1);
    });

    it("auto-pauses after 3 consecutive failures", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(
        makeAutomation({
          id: "auto-rc3",
          consecutive_failures: 2,
          enabled: 1,
          next_run_at: now + 86400000,
        })
      );

      await seedRun(
        makeRunRow("auto-rc3", {
          id: "run-rc3",
          session_id: "sess-3",
          status: "running",
          started_at: now,
        })
      );

      const stub = getSchedulerStub();
      await stub.fetch("http://internal/internal/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "auto-rc3",
          runId: "run-rc3",
          sessionId: "sess-3",
          success: false,
          error: "Third consecutive failure",
        }),
      });

      const automation = await store.getById("auto-rc3");
      expect(automation!.consecutive_failures).toBe(3);
      expect(automation!.enabled).toBe(0);
      expect(automation!.next_run_at).toBeNull();
    });

    it("does not auto-pause at fewer than 3 failures", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-rc4", consecutive_failures: 1, enabled: 1 }));

      await seedRun(
        makeRunRow("auto-rc4", {
          id: "run-rc4",
          session_id: "sess-4",
          status: "running",
          started_at: now,
        })
      );

      const stub = getSchedulerStub();
      await stub.fetch("http://internal/internal/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "auto-rc4",
          runId: "run-rc4",
          sessionId: "sess-4",
          success: false,
          error: "Second failure",
        }),
      });

      const automation = await store.getById("auto-rc4");
      expect(automation!.consecutive_failures).toBe(2);
      expect(automation!.enabled).toBe(1); // Still enabled
    });
  });

  // ─── Tick handler ─────────────────────────────────────────────────────────

  describe("/internal/tick", () => {
    it("returns empty tick summary when nothing to process", async () => {
      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.processed).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.failed).toBe(0);
    });

    it("recovers orphaned starting runs during sweep", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      // Automation NOT overdue — only recovery sweep should run
      await store.create(
        makeAutomation({ id: "auto-t1", next_run_at: now + 86400000, enabled: 1 })
      );

      const tenMinutesAgo = now - 10 * 60 * 1000;
      await seedRun(
        makeRunRow("auto-t1", {
          id: "run-orphan-t1",
          status: "starting",
          scheduled_at: tenMinutesAgo,
          created_at: tenMinutesAgo,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });
      expect(res.status).toBe(200);

      // Verify orphaned run was recovered
      const run = await store.getRunById("auto-t1", "run-orphan-t1");
      expect(run!.status).toBe("failed");
      expect(run!.failure_reason).toBe("session_creation_timeout");

      // Verify failure count incremented
      const automation = await store.getById("auto-t1");
      expect(automation!.consecutive_failures).toBe(1);
    });

    it("recovers timed-out running runs during sweep", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(
        makeAutomation({ id: "auto-t2", next_run_at: now + 86400000, enabled: 1 })
      );

      // Default EXECUTION_TIMEOUT_MS is 90 minutes
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      await seedRun(
        makeRunRow("auto-t2", {
          id: "run-timeout-t2",
          status: "running",
          session_id: "sess-timeout",
          scheduled_at: twoHoursAgo,
          started_at: twoHoursAgo,
          created_at: twoHoursAgo,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });
      expect(res.status).toBe(200);

      const run = await store.getRunById("auto-t2", "run-timeout-t2");
      expect(run!.status).toBe("failed");
      expect(run!.failure_reason).toBe("execution_timeout");
    });

    it("skips overdue automations with active runs (concurrency guard)", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      // Overdue automation
      await store.create(makeAutomation({ id: "auto-t3", next_run_at: now - 60000, enabled: 1 }));

      // Existing active run
      await seedRun(
        makeRunRow("auto-t3", {
          id: "run-active-t3",
          status: "running",
          session_id: "sess-existing",
          scheduled_at: now - 120000,
          started_at: now - 120000,
          created_at: now - 120000,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.skipped).toBeGreaterThanOrEqual(1);

      // Assert on the automation this test owns rather than only the tick's
      // global counters: auto-t3 must get exactly one skipped firing — a
      // childless invocation — and its schedule must advance into the future so
      // it isn't re-skipped on every later tick.
      const { invocations } = await store.listInvocations("auto-t3", {
        limit: 10,
        offset: 0,
      });
      const skipped = invocations.filter((inv) => inv.status === "skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.skipReason).toBe("concurrent_run_active");
      expect(skipped[0]!.runs).toHaveLength(0);

      const advanced = await store.getById("auto-t3");
      expect(advanced!.next_run_at).not.toBeNull();
      expect(advanced!.next_run_at!).toBeGreaterThan(now);
    });

    it("processes overdue automations (creates run, advances schedule)", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      const overdue = makeAutomation({
        id: "auto-t4",
        next_run_at: now - 60000,
        enabled: 1,
        schedule_cron: "0 9 * * *",
        schedule_tz: "UTC",
      });
      await store.create(overdue);

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json<{ processed: number; skipped: number; failed: number }>();
      expect(body.processed + body.failed).toBeGreaterThanOrEqual(1);

      // Assert on auto-t4 specifically rather than the tick's global counters.
      // Session creation may succeed or fail in the test env; either way the
      // automation must get exactly one run (linked to its invocation) and its
      // schedule must advance into the future so it isn't reprocessed on the
      // next tick.
      const runs = await fetchRuns("auto-t4");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.invocation_id).not.toBeNull();

      const automation = await store.getById("auto-t4");
      expect(automation!.next_run_at).not.toBeNull();
      expect(automation!.next_run_at!).toBeGreaterThan(now);
    });

    it("auto-pauses after recovery sweep detects 3rd consecutive failure", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(
        makeAutomation({
          id: "auto-t5",
          next_run_at: now + 86400000,
          enabled: 1,
          consecutive_failures: 2,
        })
      );

      const tenMinutesAgo = now - 10 * 60 * 1000;
      await seedRun(
        makeRunRow("auto-t5", {
          id: "run-orphan-t5",
          status: "starting",
          scheduled_at: tenMinutesAgo,
          created_at: tenMinutesAgo,
        })
      );

      const stub = getSchedulerStub();
      await stub.fetch("http://internal/internal/tick", { method: "POST" });

      const automation = await store.getById("auto-t5");
      expect(automation!.consecutive_failures).toBe(3);
      expect(automation!.enabled).toBe(0);
      expect(automation!.next_run_at).toBeNull();
    });

    it("bulk recovery handles multiple orphaned runs for the same automation", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(
        makeAutomation({ id: "auto-t6", next_run_at: now + 86400000, enabled: 1 })
      );

      const tenMinutesAgo = now - 10 * 60 * 1000;
      const runIds = ["run-bulk-1", "run-bulk-2", "run-bulk-3"];
      for (let i = 0; i < runIds.length; i++) {
        await seedRun(
          makeRunRow("auto-t6", {
            id: runIds[i],
            status: "starting",
            scheduled_at: tenMinutesAgo - i,
            created_at: tenMinutesAgo - i,
          })
        );
      }

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/tick", { method: "POST" });
      expect(res.status).toBe(200);

      for (const runId of runIds) {
        const run = await store.getRunById("auto-t6", runId);
        expect(run!.status).toBe("failed");
        expect(run!.failure_reason).toBe("session_creation_timeout");
      }

      const automation = await store.getById("auto-t6");
      expect(automation!.consecutive_failures).toBe(3);
    });
  });

  // ─── Trigger handler ──────────────────────────────────────────────────────

  describe("/internal/trigger", () => {
    it("returns 400 when automationId is missing", async () => {
      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when automation not found", async () => {
      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: "nonexistent" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 when active run exists", async () => {
      const store = new AutomationStore(env.DB);
      const now = Date.now();
      await store.create(makeAutomation({ id: "auto-trig1" }));

      await seedRun(
        makeRunRow("auto-trig1", {
          id: "run-trig-active",
          status: "running",
          session_id: "sess-1",
          started_at: now,
        })
      );

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: "auto-trig1" }),
      });
      expect(res.status).toBe(409);
    });

    it("creates a run record when triggered", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-trig2" }));

      const stub = getSchedulerStub();
      const res = await stub.fetch("http://internal/internal/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: "auto-trig2" }),
      });

      // Trigger will attempt session creation. In test env it may succeed (201)
      // or fail at prompt sending (500). Either way, a run record is created.
      expect([201, 500]).toContain(res.status);

      const runs = await fetchRuns("auto-trig2");
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs[0]!.invocation_id).not.toBeNull();
    });
  });

  // ─── Invocation finalization (D2) ─────────────────────────────────────────

  describe("invocation finalization", () => {
    /** Seed an invocation with N children in the given statuses via the real guarded insert. */
    async function seedInvocation(
      store: AutomationStore,
      automationId: string,
      invocationId: string,
      children: Array<{ id: string; status: string; failed?: boolean }>
    ): Promise<void> {
      const now = Date.now();
      const { inserted } = await store.insertInvocationGuarded({
        invocation: {
          id: invocationId,
          automation_id: automationId,
          source: "manual",
          scheduled_at: null,
          trigger_key: null,
          concurrency_key: null,
          trigger_metadata: null,
          skip_reason: null,
          failure_counted_at: null,
          created_at: now,
          updated_at: now,
        },
        children: children.map((child, index) => ({
          id: child.id,
          automation_id: automationId,
          invocation_id: invocationId,
          session_id: child.status === "starting" ? null : `sess-${child.id}`,
          status: child.status,
          skip_reason: null,
          failure_reason: child.status === "failed" ? "seeded failure" : null,
          scheduled_at: now,
          started_at: child.status === "starting" ? null : now,
          completed_at: child.status === "failed" || child.status === "completed" ? now : null,
          created_at: now + index,
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          environment_id: null,
        })),
        overlapScope: { kind: "automation" },
      });
      expect(inserted).toBe(true);
    }

    async function completeRun(
      automationId: string,
      runId: string,
      success: boolean
    ): Promise<Response> {
      const stub = getSchedulerStub();
      return stub.fetch("http://internal/internal/run-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId,
          runId,
          sessionId: `sess-${runId}`,
          success,
          ...(success ? {} : { error: "boom" }),
        }),
      });
    }

    it("resets the streak only after the LAST sibling completes; automation stays schedulable (F1)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-f1", consecutive_failures: 2 }));
      await seedInvocation(store, "auto-f1", "inv-f1", [
        { id: "run-f1-a", status: "running" },
        { id: "run-f1-b", status: "running" },
      ]);

      await completeRun("auto-f1", "run-f1-a", true);
      // One sibling still active — no reset yet.
      let automation = await store.getById("auto-f1");
      expect(automation!.consecutive_failures).toBe(2);

      await completeRun("auto-f1", "run-f1-b", true);
      automation = await store.getById("auto-f1");
      expect(automation!.consecutive_failures).toBe(0);

      // No active runs remain — the automation is schedulable next tick.
      expect(await store.getActiveRunForAutomation("auto-f1")).toBeNull();
    });

    it("a partial failure strikes exactly once and never resets (F1/F3)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-f3", consecutive_failures: 0 }));
      await seedInvocation(store, "auto-f3", "inv-f3", [
        { id: "run-f3-a", status: "running" },
        { id: "run-f3-b", status: "running" },
      ]);

      await completeRun("auto-f3", "run-f3-a", false);
      let automation = await store.getById("auto-f3");
      expect(automation!.consecutive_failures).toBe(1);

      // The sibling's success finishes the invocation as partial_failed —
      // no reset, and no second strike.
      await completeRun("auto-f3", "run-f3-b", true);
      automation = await store.getById("auto-f3");
      expect(automation!.consecutive_failures).toBe(1);

      const invocation = await store.getInvocationById("inv-f3");
      expect(invocation!.failure_counted_at).not.toBeNull();
    });

    it("the sweep applies a strike missed in the crash window, exactly once (F2)", async () => {
      const store = new AutomationStore(env.DB);
      const future = Date.now() + 86400000;
      await store.create(
        makeAutomation({ id: "auto-f2", consecutive_failures: 0, next_run_at: future })
      );
      // All-terminal failed invocation whose accounting never ran (the process
      // died after the child update, before the callback's accounting).
      await seedInvocation(store, "auto-f2", "inv-f2", [{ id: "run-f2-a", status: "failed" }]);

      const stub = getSchedulerStub();
      await stub.fetch("http://internal/internal/tick", { method: "POST" });

      let automation = await store.getById("auto-f2");
      expect(automation!.consecutive_failures).toBe(1);

      // A second sweep must not double-strike (failure_counted_at CAS).
      await stub.fetch("http://internal/internal/tick", { method: "POST" });
      automation = await store.getById("auto-f2");
      expect(automation!.consecutive_failures).toBe(1);
    });

    it("the sweep applies a reset missed in the crash window (F2)", async () => {
      const store = new AutomationStore(env.DB);
      const future = Date.now() + 86400000;
      await store.create(
        makeAutomation({ id: "auto-f2r", consecutive_failures: 2, next_run_at: future })
      );
      await seedInvocation(store, "auto-f2r", "inv-f2r", [
        { id: "run-f2r-a", status: "completed" },
        { id: "run-f2r-b", status: "completed" },
      ]);

      const stub = getSchedulerStub();
      await stub.fetch("http://internal/internal/tick", { method: "POST" });

      const automation = await store.getById("auto-f2r");
      expect(automation!.consecutive_failures).toBe(0);
    });
  });

  // ─── Unknown routes ────────────────────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    const stub = getSchedulerStub();
    const res = await stub.fetch("http://internal/unknown", { method: "GET" });
    expect(res.status).toBe(404);
  });
});
