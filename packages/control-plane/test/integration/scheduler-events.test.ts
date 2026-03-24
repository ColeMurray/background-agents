import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import type { SentryAutomationEvent, WebhookAutomationEvent } from "@open-inspect/shared";
import { cleanD1Tables } from "./cleanup";

function getSchedulerStub() {
  const id = env.SCHEDULER.idFromName("global-scheduler");
  return env.SCHEDULER.get(id);
}

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
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
    trigger_key: null,
    concurrency_key: null,
    ...overrides,
  };
}

async function sendEvent(event: SentryAutomationEvent | WebhookAutomationEvent): Promise<Response> {
  const stub = getSchedulerStub();
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  };
  try {
    return await stub.fetch("http://internal/internal/event", opts);
  } catch (e) {
    // Retry once on DO invalidation (singleWorker + isolatedStorage:false race)
    if (e instanceof Error && e.message.includes("invalidating this Durable Object")) {
      const retryStub = env.SCHEDULER.get(env.SCHEDULER.idFromName("global-scheduler"));
      return retryStub.fetch("http://internal/internal/event", {
        ...opts,
        body: JSON.stringify(event),
      });
    }
    throw e;
  }
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

describe("SchedulerDO /internal/event (integration)", () => {
  beforeEach(cleanD1Tables);

  // ─── Sentry event matching ───────────────────────────────────────────────

  describe("sentry event matching", () => {
    it("triggers a matching sentry automation and creates a run", async () => {
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

      const event = makeSentryEvent(automationId);
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      // Session creation will fail in test env, but the run is still created.
      // triggered may be 0 if session creation fails (failRunAndTrack catches it),
      // but the run row should exist regardless.
      expect(body.triggered + body.skipped).toBeLessThanOrEqual(1);

      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBeGreaterThanOrEqual(1);

      const run = runs.runs[0];
      expect(run.automation_id).toBe(automationId);
      expect(run.trigger_key).toBe(event.triggerKey);
      expect(run.concurrency_key).toBe(event.concurrencyKey);
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
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      expect(body.triggered + body.skipped).toBeLessThanOrEqual(1);

      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBeGreaterThanOrEqual(1);

      const run = runs.runs[0];
      expect(run.automation_id).toBe(automationId);
      expect(run.trigger_key).toBe(event.triggerKey);
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
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      expect(body.triggered).toBe(0);
      expect(body.skipped).toBe(0);

      // Verify no run was created
      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBe(0);
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
      const res = await sendEvent(event);

      expect(res.status).toBe(200);

      // A run should be created (even though session creation fails)
      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBeGreaterThanOrEqual(1);
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
      const res1 = await sendEvent(event);
      expect(res1.status).toBe(200);

      const runs1 = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs1.total).toBe(1);

      // Second event with same trigger_key — should be skipped via UNIQUE constraint
      const res2 = await sendEvent(event);
      expect(res2.status).toBe(200);
      const body2 = await res2.json<{ triggered: number; skipped: number }>();
      expect(body2.skipped).toBe(1);

      // Still only one run
      const runs2 = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs2.total).toBe(1);
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

      // Insert an active run with the same concurrency key
      await store.insertRun(
        makeRun(automationId, {
          status: "running",
          session_id: "sess-existing",
          started_at: Date.now(),
          concurrency_key: concurrencyKey,
          trigger_key: `sentry_issue:first-${Date.now()}`,
        })
      );

      // Send a new event with the same concurrency key but different trigger key
      const event = makeSentryEvent(automationId, {
        concurrencyKey,
        triggerKey: `sentry_issue:second-${Date.now()}`,
      });
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      expect(body.skipped).toBe(1);
      expect(body.triggered).toBe(0);

      // Only the original run should exist — no new run created
      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBe(1);
      expect(runs.runs[0].concurrency_key).toBe(concurrencyKey);
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
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      expect(body.triggered).toBe(0);
      expect(body.skipped).toBe(0);

      // No runs created
      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBe(0);
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
      const res = await sendEvent(event);

      expect(res.status).toBe(200);
      const body = await res.json<{ triggered: number; skipped: number }>();
      expect(body.triggered).toBe(0);
      expect(body.skipped).toBe(0);

      const runs = await store.listRunsForAutomation(automationId, { limit: 10, offset: 0 });
      expect(runs.total).toBe(0);
    });
  });
});
