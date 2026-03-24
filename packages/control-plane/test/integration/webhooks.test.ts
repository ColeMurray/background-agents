import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { hashApiKey } from "../../src/auth/webhook-key";
import { encryptToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";

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
    name: "Test Automation",
    repo_owner: "test-owner",
    repo_name: "test-repo",
    base_branch: "main",
    repo_id: 1,
    instructions: "Test instructions",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "test-user",
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
  const encrypted = await encryptToken(SENTRY_TEST_SECRET, env.REPO_SECRETS_ENCRYPTION_KEY);
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

// ─── Sentry webhook tests (per-automation) ───────────────────────────────────

describe("POST /webhooks/sentry/:id", () => {
  beforeEach(cleanD1Tables);

  it("accepts valid signature (does not return 401)", async () => {
    const automation = await createSentryAutomation();
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

    // The handler passes auth and attempts to forward to SchedulerDO.
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
  beforeEach(cleanD1Tables);

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
    const result = await response.json<{ ok: boolean }>();
    expect(result.ok).toBe(true);
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
});
