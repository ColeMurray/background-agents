import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { seedActiveUser, sqlDatabase } from "./helpers";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import type { SentryAutomationEvent, WebhookAutomationEvent } from "@open-inspect/shared/triggers";
import { cleanD1Tables } from "./cleanup";
import { makeRunRow, seedRun, fetchRuns } from "./run-helpers";
import { Scheduler } from "../../src/scheduler/scheduler";
import type { Env } from "../../src/types";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    instructions: "Investigate and fix",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: now + 86400000,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

function sendEvent(event: SentryAutomationEvent | WebhookAutomationEvent) {
  return new Scheduler(env.DB, env as Env, { submit() {} }).event(event);
}

function makeSentryEvent(
  automationId: string,
  overrides?: Partial<SentryAutomationEvent>
): SentryAutomationEvent {
  return {
    source: "sentry",
    automationId,
    eventType: "issue.created",
    triggerKey: `sentry_issue:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    concurrencyKey: `sentry_issue:${Date.now()}`,
    contextBlock: "Sentry issue: NullPointerException in api/handler.ts",
    meta: { issueId: "12345" },
    sentryProject: "backend",
    sentryLevel: "error",
    ...overrides,
  };
}

function makeWebhookEvent(
  automationId: string,
  overrides?: Partial<WebhookAutomationEvent>
): WebhookAutomationEvent {
  return {
    source: "webhook",
    eventType: "webhook.received",
    triggerKey: `webhook:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    concurrencyKey: `webhook:${automationId}`,
    contextBlock: "Webhook received with payload",
    meta: {},
    automationId,
    body: { action: "deploy" },
    ...overrides,
  };
}

describe("Scheduler event handling (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });

  // ─── Sentry event matching ───────────────────────────────────────────────

  describe("sentry event matching", () => {
    it("triggers a matching sentry automation as an invocation of 1", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-sentry-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
        })
      );
      // Keep this matching test independent of SessionDO and sandbox startup.
      // A deleted environment still produces one child, which fails locally
      // during target resolution after the invocation is persisted.
      await sqlDatabase(env.DB).batch(
        store.bindReplaceEnvironments(automationId, ["env-deleted"], Date.now())
      );

      const event = makeSentryEvent(automationId);
      const result = await sendEvent(event);

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(1);

      const run = runs[0]!;
      expect(run).toMatchObject({
        automation_id: automationId,
        environment_id: "env-deleted",
        status: "failed",
      });
      // Firing keys live on the invocation, not the child run.
      expect(run.invocation_id).not.toBeNull();
      const invocation = await store.getInvocationById(run.invocation_id);
      expect(invocation).toMatchObject({
        source: "event",
        trigger_key: event.triggerKey,
        concurrency_key: event.concurrencyKey,
      });
      const { total } = await store.listInvocations(automationId, { limit: 10, offset: 0 });
      expect(total).toBe(1);
    });
  });

  // ─── Webhook event matching ──────────────────────────────────────────────

  describe("webhook event matching", () => {
    it("triggers a matching webhook automation and creates a run", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-webhook-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "webhook",
          event_type: "webhook.received",
          schedule_cron: null,
          next_run_at: null,
        })
      );

      const event = makeWebhookEvent(automationId);
      const result = await sendEvent(event);

      expect(result.triggered + result.skipped).toBeLessThanOrEqual(1);

      const runs = await fetchRuns(automationId);
      expect(runs.length).toBeGreaterThanOrEqual(1);

      const run = runs[0]!;
      expect(run.automation_id).toBe(automationId);
      const invocation = await store.getInvocationById(run.invocation_id);
      expect(invocation!.trigger_key).toBe(event.triggerKey);
    });
  });

  // ─── Condition filtering ─────────────────────────────────────────────────

  describe("condition filtering", () => {
    it("does not trigger when sentry_project condition does not match", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-cond-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
          trigger_config: JSON.stringify({
            conditions: [{ type: "sentry_project", operator: "any_of", value: ["backend"] }],
          }),
        })
      );

      // Send event with a non-matching project
      const event = makeSentryEvent(automationId, { sentryProject: "frontend" });
      const result = await sendEvent(event);

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

      // Verify no run was created
      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(0);
    });

    it("triggers when sentry_project condition matches", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-cond-match-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
          trigger_config: JSON.stringify({
            conditions: [{ type: "sentry_project", operator: "any_of", value: ["backend"] }],
          }),
        })
      );

      const event = makeSentryEvent(automationId, { sentryProject: "backend" });
      const result = await sendEvent(event);

      expect(result.steered).toBe(0);

      // A run should be created (even though session creation fails)
      const runs = await fetchRuns(automationId);
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Dedup via trigger_key ───────────────────────────────────────────────

  describe("dedup via trigger_key", () => {
    it("skips a duplicate event with the same trigger_key", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-dedup-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
        })
      );

      const sharedTriggerKey = `sentry_issue:dedup-${Date.now()}`;
      const event = makeSentryEvent(automationId, { triggerKey: sharedTriggerKey });

      // First event — should create a run
      const result1 = await sendEvent(event);
      expect(result1.steered).toBe(0);

      const runs1 = await fetchRuns(automationId);
      expect(runs1).toHaveLength(1);

      // Second event with the same trigger_key but a DIFFERENT concurrency key
      // (so the per-key overlap guard cannot intercept it first) — rejected
      // atomically by the invocation trigger-key index; a dedup is a silent
      // no-op, not a skip row.
      const result2 = await sendEvent({
        ...event,
        concurrencyKey: `sentry_issue:redelivery-${Date.now()}`,
      });
      expect(result2).toEqual({ triggered: 0, skipped: 1, steered: 0 });

      const runs2 = await fetchRuns(automationId);
      expect(runs2).toHaveLength(1);
      const { total } = await store.listInvocations(automationId, { limit: 10, offset: 0 });
      expect(total).toBe(1);
    });
  });

  // ─── Concurrency via concurrency_key ─────────────────────────────────────

  describe("concurrency via concurrency_key", () => {
    it("skips when an active run exists with the same concurrency_key", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-concur-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
        })
      );

      const concurrencyKey = `sentry_issue:concurrency-${Date.now()}`;

      // An active run under an invocation carrying the concurrency key must
      // block a new event for the same key.
      const activeInvId = `inv-active-${Date.now()}`;
      await env.DB.prepare(
        `INSERT INTO automation_invocations
           (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
         VALUES (?, ?, 'event', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`
      )
        .bind(
          activeInvId,
          automationId,
          `sentry_issue:first-${Date.now()}`,
          concurrencyKey,
          Date.now(),
          Date.now()
        )
        .run();
      await seedRun(
        makeRunRow(automationId, {
          invocation_id: activeInvId,
          status: "running",
          session_id: "sess-existing",
          started_at: Date.now(),
        })
      );

      // Send a new event with the same concurrency key but different trigger key
      const event = makeSentryEvent(automationId, {
        concurrencyKey,
        triggerKey: `sentry_issue:second-${Date.now()}`,
      });
      const result = await sendEvent(event);

      expect(result).toEqual({ triggered: 0, skipped: 1, steered: 0 });

      // Only the original run exists; the skip is a childless invocation.
      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(1);
      const activeInvocation = await store.getInvocationById(runs[0]!.invocation_id);
      expect(activeInvocation!.concurrency_key).toBe(concurrencyKey);

      const { invocations } = await store.listInvocations(automationId, {
        limit: 10,
        offset: 0,
      });
      const skips = invocations.filter((invocation) => invocation.status === "skipped");
      expect(skips).toHaveLength(1);
      expect(skips[0]!.skipReason).toBe("concurrent_run_active");
    });

    it("does not block a different concurrency key (per-key scope)", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-perkey-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
        })
      );

      // The active run's firing key lives on its invocation: seed it there so
      // this proves per-key scoping, not merely keyed-vs-unkeyed.
      await seedRun(
        makeRunRow(automationId, {
          status: "running",
          session_id: "sess-existing",
          started_at: Date.now(),
        }),
        { concurrencyKey: "sentry_issue:42" }
      );

      const event = makeSentryEvent(automationId, {
        concurrencyKey: "sentry_issue:43",
        triggerKey: `sentry_issue:43-${Date.now()}`,
      });
      const result = await sendEvent(event);

      expect(result.steered).toBe(0);
      // A new run was created despite the unrelated active run.
      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(2);
    });
  });

  // ─── Disabled automation ─────────────────────────────────────────────────

  describe("disabled automation", () => {
    it("does not match a disabled sentry automation", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-disabled-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "sentry",
          event_type: "issue.created",
          schedule_cron: null,
          next_run_at: null,
          enabled: 0,
        })
      );

      const event = makeSentryEvent(automationId);
      const result = await sendEvent(event);

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

      // No runs created
      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(0);
    });

    it("does not match a disabled webhook automation", async () => {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-disabled-wh-${Date.now()}`;
      await store.create(
        makeAutomation({
          id: automationId,
          trigger_type: "webhook",
          event_type: "webhook.received",
          schedule_cron: null,
          next_run_at: null,
          enabled: 0,
        })
      );

      const event = makeWebhookEvent(automationId);
      const result = await sendEvent(event);

      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

      const runs = await fetchRuns(automationId);
      expect(runs).toHaveLength(0);
    });
  });
});
