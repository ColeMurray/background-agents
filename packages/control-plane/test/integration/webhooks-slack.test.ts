import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function makeSlackEventBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  const ts = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:C1:${ts}`,
    concurrencyKey: `slack:C1:${ts}`,
    contextBlock: "A message was posted in Slack channel #ops by user U1.",
    meta: {},
    channelId: "C1",
    ts,
    actorUserId: "U1",
    text: "please deploy the api",
    ...overrides,
  };
}

function makeSlackAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-slack-${Math.random().toString(36).slice(2, 8)}`,
    name: "Slack triage",
    repo_owner: null,
    repo_name: null,
    base_branch: null,
    repo_id: null,
    instructions: "Investigate and fix",
    trigger_type: "slack_event",
    schedule_cron: null,
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: "message.posted",
    trigger_config: JSON.stringify({
      conditions: [
        { type: "slack_channel", operator: "any_of", value: ["C1"] },
        { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
      ],
    }),
    trigger_auth_data: null,
    ...overrides,
  };
}

async function seedSlackAutomation(): Promise<string> {
  const store = new AutomationStore(env.DB);
  const automation = makeSlackAutomation();
  await store.create(automation);
  await new SlackChannelStore(env.DB).setSlackChannels(automation.id, ["C1"]);
  return automation.id;
}

async function postEvent(
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<Response> {
  return SELF.fetch("https://test.local/internal/slack-event", {
    method: "POST",
    headers: headers ?? (await authHeaders()),
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /internal/slack-event (integration)", () => {
  beforeEach(cleanD1Tables);

  it("returns 401 without an internal token", async () => {
    const res = await postEvent(makeSlackEventBody(), { "Content-Type": "application/json" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid internal token", async () => {
    const res = await postEvent(makeSlackEventBody(), {
      Authorization: "Bearer not-a-valid-token",
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await SELF.fetch("https://test.local/internal/slack-event", {
      method: "POST",
      headers: await authHeaders(),
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it.each(["null", "[]", "42"])(
    "returns 400 when the JSON body is not an object (%s)",
    async (raw) => {
      const res = await SELF.fetch("https://test.local/internal/slack-event", {
        method: "POST",
        headers: await authHeaders(),
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("must be a JSON object");
    }
  );

  it("returns 400 when source is not 'slack'", async () => {
    const res = await postEvent(makeSlackEventBody({ source: "github" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("source");
  });

  it("returns 400 when channelId is missing", async () => {
    const res = await postEvent(makeSlackEventBody({ channelId: undefined }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("channelId");
  });

  it("returns 400 when ts is missing", async () => {
    const res = await postEvent(makeSlackEventBody({ ts: undefined }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("ts");
  });

  it("returns 400 when eventType/triggerKey/concurrencyKey are missing", async () => {
    const res = await postEvent(makeSlackEventBody({ triggerKey: undefined }));
    expect(res.status).toBe(400);
  });

  it("forwards a valid event to the scheduler and returns trigger counts", async () => {
    const id = await seedSlackAutomation();
    const body = makeSlackEventBody({ text: "please deploy the api" });

    // The DO can transiently throw an invalidation error in the test runtime,
    // which the handler surfaces as a 502. Retry once to absorb that.
    let res = await postEvent(body);
    if (res.status === 502) {
      res = await postEvent(body);
    }

    expect(res.status).toBe(200);
    const result = await res.json<{ ok: boolean; triggered: number; skipped: number }>();
    expect(result.ok).toBe(true);
    expect(result.triggered).toBe(1);
    expect(result.skipped).toBe(0);

    // The forward actually materialized an invocation (of 1) for the seeded
    // automation, carrying the event's dedup key.
    const store = new AutomationStore(env.DB);
    const { invocations } = await store.listInvocations(id, { limit: 10, offset: 0 });
    const invocation = invocations.find((row) => row.id);
    expect(invocation).toBeDefined();
    expect(invocation!.runs).toHaveLength(1);
    const invocationRow = await store.getInvocationById(invocation!.id);
    expect(invocationRow!.trigger_key).toBe(body.triggerKey);
  });
});
