import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { sqlDatabase } from "./helpers";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import type { AutomationRunStatus } from "@open-inspect/shared/types/automations";
import { cleanD1Tables } from "./cleanup";
import { makeRunRow, seedRun, fetchRuns } from "./run-helpers";
import { Scheduler, resolveAutomationProviderAuth } from "../../src/scheduler/scheduler";
import { AutomationModelProviderAuthStore } from "../../src/db/automation-model-provider-auth";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderDefaultStore } from "../../src/db/provider-account-defaults";
import type { Env } from "../../src/types";

function createScheduler(schedulerEnv = env as Env) {
  return new Scheduler(env.DB, schedulerEnv, { submit() {} });
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

describe("Scheduler (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.exec(
      "DELETE FROM model_provider_account_defaults; DELETE FROM model_provider_accounts;"
    );
  });

  describe("automation provider auth resolution", () => {
    const accountIds = {
      openai: "00000000000000000000000000000001",
      xai: "00000000000000000000000000000002",
    } as const;

    async function seedProviderAccounts(): Promise<void> {
      const accounts = new ModelProviderAccountStore(env.DB);
      const defaults = new ProviderDefaultStore(env.DB);
      for (const provider of ["openai", "xai"] as const) {
        await accounts.create({
          id: accountIds[provider],
          provider,
          displayName: provider,
        });
        await defaults.set(provider, accountIds[provider], "provider_account", null);
      }
    }

    it.each(["openai", "xai"] as const)("uses an account pin for %s", async (provider) => {
      await seedProviderAccounts();
      const automation = makeAutomation({ id: `auto-account-${provider}` });
      await new AutomationStore(env.DB).create(automation);
      const authStore = new AutomationModelProviderAuthStore(env.DB);
      await sqlDatabase(env.DB).batch(
        authStore.bindReplace(
          automation.id,
          {
            [provider]: { mode: "provider_account", accountId: accountIds[provider] },
          },
          Date.now()
        )
      );

      const resolved = await resolveAutomationProviderAuth(env.DB, automation.id);

      expect(resolved).toContainEqual({
        provider,
        authMode: "provider_account",
        providerAccountId: accountIds[provider],
        selectionSource: "automation_pin",
      });
    });

    it.each(["openai", "xai"] as const)("uses an API-key pin for %s", async (provider) => {
      await seedProviderAccounts();
      const automation = makeAutomation({ id: `auto-api-key-${provider}` });
      await new AutomationStore(env.DB).create(automation);
      const authStore = new AutomationModelProviderAuthStore(env.DB);
      await sqlDatabase(env.DB).batch(
        authStore.bindReplace(automation.id, { [provider]: { mode: "api_key" } }, Date.now())
      );

      const resolved = await resolveAutomationProviderAuth(env.DB, automation.id);

      expect(resolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider,
            authMode: "api_key",
            selectionSource: "automation_pin",
          }),
        ])
      );
    });

    it.each(["openai", "xai"] as const)(
      "resolves the unattended policy on every unpinned %s run",
      async (provider) => {
        await seedProviderAccounts();
        const automation = makeAutomation({ id: `auto-policy-${provider}` });
        await new AutomationStore(env.DB).create(automation);
        const defaults = new ProviderDefaultStore(env.DB);
        await defaults.set(provider, accountIds[provider], "api_key", null);

        await expect(resolveAutomationProviderAuth(env.DB, automation.id)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider,
              authMode: "api_key",
              selectionSource: "unattended_policy",
            }),
          ])
        );

        await defaults.set(provider, accountIds[provider], "provider_account", null);
        await expect(resolveAutomationProviderAuth(env.DB, automation.id)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider,
              authMode: "provider_account",
              providerAccountId: accountIds[provider],
              selectionSource: "unattended_policy",
            }),
          ])
        );
      }
    );
  });

  // ─── Run complete callback ────────────────────────────────────────────────

  describe("run completion", () => {
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

      const result = await createScheduler().runComplete({
        automationId: "auto-rc1",
        runId: "run-rc1",
        sessionId: "sess-1",
        messageId: "msg-1",
        success: true,
      });

      expect(result).toBeUndefined();

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

      const result = await createScheduler().runComplete({
        automationId: "auto-rc2",
        runId: "run-rc2",
        sessionId: "sess-2",
        messageId: "msg-2",
        success: false,
        error: "Sandbox crashed",
      });

      expect(result).toBeUndefined();

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

      const result = await createScheduler().runComplete({
        automationId: "auto-rc3",
        runId: "run-rc3",
        sessionId: "sess-3",
        messageId: "msg-3",
        success: false,
        error: "Third consecutive failure",
      });
      expect(result).toBeUndefined();

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

      const result = await createScheduler().runComplete({
        automationId: "auto-rc4",
        runId: "run-rc4",
        sessionId: "sess-4",
        messageId: "msg-4",
        success: false,
        error: "Second failure",
      });
      expect(result).toBeUndefined();

      const automation = await store.getById("auto-rc4");
      expect(automation!.consecutive_failures).toBe(2);
      expect(automation!.enabled).toBe(1); // Still enabled
    });
  });

  // ─── Tick handler ─────────────────────────────────────────────────────────

  describe("scheduled tick", () => {
    it("returns empty tick summary when nothing to process", async () => {
      const result = await createScheduler().tick();

      expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });
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

      const result = await createScheduler().tick();
      expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });

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

      const result = await createScheduler().tick();
      expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });

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

      const result = await createScheduler().tick();
      expect(result).toMatchObject({ processed: 0, skipped: expect.any(Number), failed: 0 });
      expect(result.skipped).toBeGreaterThanOrEqual(1);

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

      const result = await createScheduler().tick();
      expect(result.processed + result.failed).toBeGreaterThanOrEqual(1);

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

      await createScheduler().tick();

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

      await createScheduler().tick();

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

  describe("manual trigger", () => {
    it("admits exactly one run across two triggers and a concurrent tick", async () => {
      const store = new AutomationStore(env.DB);
      const dueAt = Date.now() - 60_000;
      await store.create(
        makeAutomation({
          id: "auto-concurrent-admission",
          schedule_cron: "* * * * *",
          next_run_at: dueAt,
        })
      );

      const requestPath = (input: RequestInfo | URL) =>
        new URL(
          typeof input === "string" ? input : input instanceof Request ? input.url : input.href
        ).pathname;
      const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = requestPath(input);
        if (path === "/internal/init") return Response.json({ status: "ok" });
        if (path === "/internal/prompt") {
          return Response.json({ messageId: "msg-concurrent", status: "queued" });
        }
        return new Response("Not Found", { status: 404 });
      });
      const schedulerEnv = {
        ...(env as Env),
        SESSION: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ fetch: sessionFetch })),
        } as unknown as DurableObjectNamespace,
      };

      const schedulers = [
        createScheduler(schedulerEnv),
        createScheduler(schedulerEnv),
        createScheduler(schedulerEnv),
      ];

      const [triggerA, triggerB, tick] = await Promise.allSettled([
        schedulers[0]!.trigger("auto-concurrent-admission"),
        schedulers[1]!.trigger("auto-concurrent-admission"),
        schedulers[2]!.tick(),
      ]);

      // Exactly one admission across all three entry points: either a trigger
      // fulfills or the tick processes the firing. Every losing trigger rejects
      // as blocked.
      expect(tick.status).toBe("fulfilled");
      if (tick.status !== "fulfilled") throw tick.reason;

      const triggers = [triggerA, triggerB];
      const successfulTriggers = triggers.filter((result) => result.status === "fulfilled");
      const blockedTriggers = triggers.filter((result) => result.status === "rejected");
      expect(successfulTriggers).toHaveLength(tick.value.processed === 1 ? 0 : 1);
      expect(successfulTriggers.length + tick.value.processed).toBe(1);
      for (const successful of successfulTriggers) {
        expect(successful).toMatchObject({
          status: "fulfilled",
          value: { invocationId: expect.any(String), runs: [expect.any(Object)] },
        });
      }
      expect(blockedTriggers).toHaveLength(2 - successfulTriggers.length);
      for (const blocked of blockedTriggers) {
        expect(blocked).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ message: "An active run already exists" }),
        });
      }

      const runs = await fetchRuns("auto-concurrent-admission");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "running", session_id: expect.any(String) });

      const initCalls = sessionFetch.mock.calls.filter(([input]) =>
        requestPath(input).endsWith("/internal/init")
      );
      const promptCalls = sessionFetch.mock.calls.filter(([input]) =>
        requestPath(input).endsWith("/internal/prompt")
      );
      expect(initCalls).toHaveLength(1);
      expect(promptCalls).toHaveLength(1);

      const sessionCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE automation_id = ?"
      )
        .bind("auto-concurrent-admission")
        .first<{ count: number }>();
      expect(sessionCount?.count).toBe(1);

      const automation = await store.getById("auto-concurrent-admission");
      expect(automation!.next_run_at).toBeGreaterThan(dueAt);
    });

    it("does not let a firing that lost the slot advance the schedule again", async () => {
      // Two ticks straddling a cron boundary both read slot S and compute
      // successors from their own wall clock. The winner moves S -> N. Under a
      // "later timestamp wins" guard the loser could then move N -> N2, and
      // slot N would never fire at all. Only the firing that still owns S may
      // advance it.
      const store = new AutomationStore(env.DB);
      const slot = Date.now() - 60_000;
      const winnerNext = slot + 60_000;
      const loserNext = slot + 120_000;
      await store.create(
        makeAutomation({
          id: "auto-slot-ownership",
          schedule_cron: "* * * * *",
          next_run_at: slot,
        })
      );

      const skipInvocation = (id: string) => ({
        id,
        automation_id: "auto-slot-ownership",
        source: "schedule" as const,
        scheduled_at: slot,
        trigger_key: null,
        concurrency_key: null,
        trigger_metadata: null,
        skip_reason: "concurrent_run_active",
        failure_counted_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      await store.insertSkippedInvocation(skipInvocation("inv-slot-winner"), {
        fromSlot: slot,
        nextRunAt: winnerNext,
      });
      expect((await store.getById("auto-slot-ownership"))!.next_run_at).toBe(winnerNext);

      // The loser still believes it owns `slot` and carries a later successor.
      await store.insertSkippedInvocation(skipInvocation("inv-slot-loser"), {
        fromSlot: slot,
        nextRunAt: loserNext,
      });

      expect((await store.getById("auto-slot-ownership"))!.next_run_at).toBe(winnerNext);
    });

    it("rejects when automation is not found", async () => {
      await expect(createScheduler().trigger("nonexistent")).rejects.toThrow(
        "Automation not found"
      );
    });

    it("rejects when active run exists", async () => {
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

      await expect(createScheduler().trigger("auto-trig1")).rejects.toThrow(
        "An active run already exists"
      );
    });

    it("creates a run record when triggered", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-trig2" }));

      const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof Request ? input.url : input.href
        ).pathname;
        if (path === "/internal/init") return Response.json({ status: "ok" });
        if (path === "/internal/prompt") {
          return Response.json({ messageId: "msg-trigger", status: "queued" });
        }
        return new Response("Not Found", { status: 404 });
      });
      const schedulerEnv = {
        ...(env as Env),
        SESSION: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ fetch: sessionFetch })),
        } as unknown as DurableObjectNamespace,
      };

      const result = await createScheduler(schedulerEnv).trigger("auto-trig2");
      expect(result).toEqual({
        invocationId: expect.any(String),
        runs: [expect.objectContaining({ status: "running" })],
      });

      const runs = await fetchRuns("auto-trig2");
      expect(runs).toHaveLength(1);
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
      children: Array<{ id: string; status: AutomationRunStatus; failed?: boolean }>
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

    async function completeRun(automationId: string, runId: string, success: boolean) {
      return createScheduler().runComplete({
        automationId,
        runId,
        sessionId: `sess-${runId}`,
        messageId: `msg-${runId}`,
        success,
        ...(success ? {} : { error: "boom" }),
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

      const scheduler = createScheduler();
      await scheduler.tick();

      let automation = await store.getById("auto-f2");
      expect(automation!.consecutive_failures).toBe(1);

      // A second sweep must not double-strike (failure_counted_at CAS).
      await scheduler.tick();
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

      await createScheduler().tick();

      const automation = await store.getById("auto-f2r");
      expect(automation!.consecutive_failures).toBe(0);
    });
  });
});
