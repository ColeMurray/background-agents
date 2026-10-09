import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { WebhookInvocationStatusResponse, WebhookTriggerResponse } from "@open-inspect/shared";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { hashApiKey } from "../../src/auth/webhook-key";
import { encryptToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";
import { fetchRuns } from "./run-helpers";
import { seedActiveUser } from "./helpers";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function signSentryPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    owner_team_id: null,
    name: "Test Automation",
    instructions: "Test instructions",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "test-user",
    user_id: "test-user",
    created_at: Date.now(),
    updated_at: Date.now(),
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

const SENTRY_TEST_SECRET = "test-sentry-client-secret-for-hmac";

async function createSentryAutomation(
  overrides: Partial<AutomationRow> = {}
): Promise<AutomationRow> {
  const store = new AutomationStore(env.DB);
  const encrypted = await encryptToken(SENTRY_TEST_SECRET, env.REPO_SECRETS_ENCRYPTION_KEY!);
  const automation = makeAutomation({
    trigger_type: "sentry",
    event_type: "issue.created",
    schedule_cron: null,
    next_run_at: null,
    trigger_auth_data: encrypted,
    ...overrides,
  });
  await store.create(automation);
  return automation;
}

const sentryIssuePayload = {
  action: "triggered",
  data: {
    event: {
      event_id: "evt-1",
      title: "TypeError",
      culprit: "src/auth.ts",
      level: "error",
      metadata: { type: "TypeError", value: "oops" },
      tags: [],
    },
    issue: {
      id: "12345",
      shortId: "TEST-1",
      title: "TypeError",
      culprit: "src/auth.ts",
      level: "error",
      project: { id: 1, slug: "test-project", name: "Test" },
      count: "1",
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-01T00:00:00Z",
      status: "unresolved",
    },
    triggered_rule: "Test rule",
  },
  actor: { type: "application", id: 1, name: "Sentry" },
};

const sentryIssueCreatedPayload = {
  action: "created",
  installation: { uuid: "installation-1" },
  data: {
    issue: {
      id: "67890",
      shortId: "TEST-2",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "src/App.tsx in BrokenCheckout",
      level: "error",
      status: "unresolved",
      project: { id: "2", slug: "test-project", name: "Test" },
      count: "1",
      firstSeen: "2026-08-03T20:00:00Z",
      lastSeen: "2026-08-03T20:00:00Z",
      web_url: "https://sentry.io/issues/67890/",
    },
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
};

const sentryMetricWarningPayload = {
  action: "warning",
  data: {
    metric_alert: {
      id: 456,
      title: "Error rate > 3%",
      alert_rule: { id: 789, name: "Elevated error rate" },
      date_started: "2026-08-03T20:00:00Z",
      current_trigger: { label: "warning" },
    },
    description_text: "Error rate exceeded 3%",
    description_title: "Metric Alert",
    web_url: "https://sentry.io/alerts/456/",
  },
};

// ─── Sentry webhook tests (per-automation) ───────────────────────────────────

describe("POST /webhooks/sentry/:id", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("test-user");
  });

  it("creates an automation run for a current Sentry issue.created webhook", async () => {
    const automation = await createSentryAutomation();
    const body = JSON.stringify(sentryIssueCreatedPayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sentry-Hook-Resource": "issue",
        "sentry-hook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const result = await response.json<{ ok: boolean; skipped?: boolean }>();
    expect(result.ok).toBe(true);
    expect(result.skipped).not.toBe(true);

    const runs = await fetchRuns(automation.id);
    expect(runs).toHaveLength(1);
  });

  it("accepts valid signature (does not return 401)", async () => {
    const automation = await createSentryAutomation();
    const body = JSON.stringify(sentryIssuePayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sentry-Hook-Resource": "event_alert",
        "sentry-hook-signature": signature,
      },
      body,
    });

    // The handler passes auth and attempts to process the scheduler event.
    // In the test env, the DO may throw a transient invalidation error (500).
    // The key assertion: signature verification succeeded (not 401).
    expect(response.status).not.toBe(401);
  });

  it("returns 401 with invalid signature", async () => {
    const automation = await createSentryAutomation();
    const body = JSON.stringify(sentryIssuePayload);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": "deadbeef",
      },
      body,
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with missing signature", async () => {
    const automation = await createSentryAutomation();
    const body = JSON.stringify(sentryIssuePayload);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(401);
  });

  it("returns 200 with skipped: true for unsupported event shape", async () => {
    const automation = await createSentryAutomation();
    const unsupportedPayload = { action: "unknown", data: { something: "else" } };
    const body = JSON.stringify(unsupportedPayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const result = await response.json<{ ok: boolean; skipped: boolean }>();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns a skipped response for a signed non-object JSON payload", async () => {
    const automation = await createSentryAutomation();
    const body = "null";
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sentry-Hook-Resource": "issue",
        "sentry-hook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: true });
  });

  it("logs why an authenticated Sentry webhook was skipped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const automation = await createSentryAutomation();
    const unsupportedPayload = {
      action: "must-not-be-logged",
      data: { issue: { id: "12345", privateContext: "must-not-be-logged" } },
    };
    const body = JSON.stringify(unsupportedPayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    try {
      const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sentry-Hook-Resource": "issue",
          "sentry-hook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(200);
      const logEntries = warnSpy.mock.calls.flatMap(([line]) => {
        if (typeof line !== "string") return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          service: "control-plane",
          component: "sentry-webhook",
          event: "sentry.webhook_skipped",
          reason: "invalid_shape",
          automation_id: automation.id,
          configured_event_type: "issue.created",
          sentry_resource: "issue",
          sentry_action: "other",
          request_id: expect.any(String),
          trace_id: expect.any(String),
        })
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("must-not-be-logged");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for an intentionally ignored metric alert action", async () => {
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const automation = await createSentryAutomation({ event_type: "metric_alert.critical" });
    const body = JSON.stringify(sentryMetricWarningPayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    try {
      const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sentry-Hook-Resource": "metric_alert",
          "sentry-hook-signature": signature,
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, skipped: true });

      const infoEntries = infoSpy.mock.calls.flatMap(([line]) => {
        if (typeof line !== "string") return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      expect(infoEntries).toContainEqual(
        expect.objectContaining({
          event: "sentry.webhook_skipped",
          reason: "unsupported_action",
          sentry_resource: "metric_alert",
        })
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("returns 404 for non-sentry automation", async () => {
    const store = new AutomationStore(env.DB);
    const automation = makeAutomation({ trigger_type: "schedule" });
    await store.create(automation);

    const body = JSON.stringify(sentryIssuePayload);
    const signature = await signSentryPayload(body, SENTRY_TEST_SECRET);

    const response = await SELF.fetch(`https://test.local/webhooks/sentry/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for non-existent automation", async () => {
    const body = JSON.stringify(sentryIssuePayload);
    const response = await SELF.fetch("https://test.local/webhooks/sentry/nonexistent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": "anything",
      },
      body,
    });

    expect(response.status).toBe(404);
  });
});

// ─── Automation webhook tests ─────────────────────────────────────────────────

describe("POST /webhooks/automation/:id", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("test-user");
  });

  const TEST_API_KEY = "test-webhook-api-key-abc123";

  async function createWebhookAutomation(
    overrides: Partial<AutomationRow> = {}
  ): Promise<AutomationRow> {
    const store = new AutomationStore(env.DB);
    const hash = await hashApiKey(TEST_API_KEY);
    const automation = makeAutomation({
      trigger_type: "webhook",
      event_type: "webhook.received",
      schedule_cron: null,
      next_run_at: null,
      trigger_auth_data: hash,
      ...overrides,
    });
    await store.create(automation);
    return automation;
  }

  async function postWebhook(
    automationId: string,
    body: Record<string, unknown>
  ): Promise<WebhookTriggerResponse> {
    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automationId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json<WebhookTriggerResponse>();
  }

  it("returns 200 with valid API key", async () => {
    const automation = await createWebhookAutomation();

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ action: "deploy" }),
    });

    expect(response.status).toBe(200);
    const result = await response.json<WebhookTriggerResponse>();
    expect(result.ok).toBe(true);
    expect(result.invocationId).toEqual(expect.any(String));
    const invocation = await new AutomationStore(env.DB).getInvocationById(result.invocationId!);
    expect(invocation?.automation_id).toBe(automation.id);
  });

  it("returns the original invocation ID for a retry with the same idempotency key", async () => {
    const automation = await createWebhookAutomation();
    const body = { action: "deploy", idempotencyKey: "client-request-42" };

    const first = await postWebhook(automation.id, body);
    const retry = await postWebhook(automation.id, body);

    expect(first.invocationId).toEqual(expect.any(String));
    expect(retry).toMatchObject({ triggered: 0, skipped: 1, invocationId: first.invocationId });
  });

  it("returns a null invocation ID when the body does not match the conditions", async () => {
    const automation = await createWebhookAutomation({
      trigger_config: JSON.stringify({
        conditions: [
          {
            type: "jsonpath",
            operator: "all_match",
            value: [{ path: "$.action", comparison: "eq", value: "never" }],
          },
        ],
      }),
    });

    expect(await postWebhook(automation.id, { action: "deploy" })).toEqual({
      ok: true,
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationId: null,
    });
  });

  it("returns 401 with invalid API key", async () => {
    const automation = await createWebhookAutomation();

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ action: "deploy" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with missing API key", async () => {
    const automation = await createWebhookAutomation();

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deploy" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns 404 for non-webhook automation", async () => {
    const store = new AutomationStore(env.DB);
    const automation = makeAutomation({
      trigger_type: "schedule",
      schedule_cron: "0 9 * * *",
    });
    await store.create(automation);

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ action: "deploy" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for non-existent automation", async () => {
    const response = await SELF.fetch("https://test.local/webhooks/automation/nonexistent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ action: "deploy" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 415 for wrong Content-Type", async () => {
    const automation = await createWebhookAutomation();

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: "hello",
    });

    expect(response.status).toBe(415);
  });

  it("returns 400 for invalid JSON body", async () => {
    const automation = await createWebhookAutomation();

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  it("returns 413 for payload too large", async () => {
    const automation = await createWebhookAutomation();
    const largeBody = JSON.stringify({ data: "x".repeat(65 * 1024) });

    const response = await SELF.fetch(`https://test.local/webhooks/automation/${automation.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: largeBody,
    });

    expect(response.status).toBe(413);
  });

  describe("GET /webhooks/automation/:id/invocations/:invocationId", () => {
    function getStatus(automationId: string, invocationId: string, apiKey = TEST_API_KEY) {
      return SELF.fetch(
        `https://test.local/webhooks/automation/${automationId}/invocations/${invocationId}`,
        apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}
      );
    }

    it.each([
      { name: "a missing API key", apiKey: "", target: "own", status: 401 },
      { name: "a wrong API key", apiKey: "wrong-key", target: "own", status: 401 },
      {
        name: "another automation's invocation",
        apiKey: TEST_API_KEY,
        target: "other",
        status: 404,
      },
      { name: "an unknown invocation", apiKey: TEST_API_KEY, target: "missing", status: 404 },
    ])("rejects $name with $status", async ({ apiKey, target, status }) => {
      const automation = await createWebhookAutomation();
      const other = await createWebhookAutomation();
      const { invocationId } = await postWebhook(automation.id, { action: "deploy" });
      const automationId = target === "other" ? other.id : automation.id;

      const response = await getStatus(
        automationId,
        target === "missing" ? "inv-missing" : invocationId!,
        apiKey
      );

      expect(response.status).toBe(status);
    });

    it("hides invocations the webhook did not cause", async () => {
      const automation = await createWebhookAutomation();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO automation_invocations
           (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
         VALUES (?, ?, 'manual', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      )
        .bind("inv-manual", automation.id, now, now)
        .run();

      expect((await getStatus(automation.id, "inv-manual")).status).toBe(404);
    });

    it("returns the derived status with only run IDs, statuses, and session IDs", async () => {
      const automation = await createWebhookAutomation();
      const { invocationId } = await postWebhook(automation.id, { action: "deploy" });
      await env.DB.prepare(
        `UPDATE automation_runs SET status = 'running', session_id = ? WHERE invocation_id = ?`
      )
        .bind("sess-webhook", invocationId)
        .run();
      const [run] = await fetchRuns(automation.id);

      const response = await getStatus(automation.id, invocationId!);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json<WebhookInvocationStatusResponse>()).toEqual({
        invocationId,
        status: "running",
        runs: [{ id: run!.id, status: "running", sessionId: "sess-webhook" }],
      });
    });
  });
});
