import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import type { SlackAutomationEvent } from "@open-inspect/shared";
import { cleanD1Tables } from "./cleanup";

function getSchedulerStub() {
  const id = env.SCHEDULER.idFromName("global-scheduler");
  return env.SCHEDULER.get(id);
}

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Slack triage",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
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

function makeSlackEvent(overrides?: Partial<SlackAutomationEvent>): SlackAutomationEvent {
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

async function sendEvent(event: SlackAutomationEvent): Promise<Response> {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  };
  try {
    return await getSchedulerStub().fetch("http://internal/internal/event", opts);
  } catch (e) {
    if (e instanceof Error && e.message.includes("invalidating this Durable Object")) {
      return getSchedulerStub().fetch("http://internal/internal/event", opts);
    }
    throw e;
  }
}

/** Create a watched slack_event automation (channel C1, text_match contains "deploy"). */
async function seedSlackAutomation(
  store: AutomationStore,
  overrides?: Partial<AutomationRow>
): Promise<string> {
  const id = `auto-slack-${Math.random().toString(36).slice(2, 8)}`;
  await store.create(makeAutomation({ id, ...overrides }));
  await store.setSlackChannels(id, ["C1"]);
  return id;
}

describe("SchedulerDO /internal/event — slack (integration)", () => {
  beforeEach(cleanD1Tables);

  it("triggers a matching slack automation and records thread coordinates", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const event = makeSlackEvent({ text: "please deploy the api" });
    const res = await sendEvent(event);
    expect(res.status).toBe(200);

    const runs = await store.listRunsForAutomation(id, { limit: 10, offset: 0 });
    expect(runs.total).toBeGreaterThanOrEqual(1);
    const run = runs.runs.find((r) => r.trigger_key === event.triggerKey)!;
    expect(run).toBeDefined();
    expect(run.slack_channel).toBe("C1");
    expect(run.slack_message_ts).toBe(event.ts);
    expect(run.actor_user_id).toBe("U1");
  });

  it("does not trigger when the text_match condition fails", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const res = await sendEvent(makeSlackEvent({ text: "good morning team" }));
    const body = await res.json<{ triggered: number; skipped: number }>();
    expect(body.triggered).toBe(0);
    expect(body.skipped).toBe(0);

    const runs = await store.listRunsForAutomation(id, { limit: 10, offset: 0 });
    expect(runs.total).toBe(0);
  });

  it("does not trigger when the channel is not watched (no candidate)", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // Event in an unwatched channel — the join table returns no candidate.
    const res = await sendEvent(
      makeSlackEvent({
        channelId: "C2",
        text: "please deploy",
        triggerKey: "slack:msg:C2:1",
        concurrencyKey: "slack:C2:1",
      })
    );
    const body = await res.json<{ triggered: number; skipped: number }>();
    expect(body.triggered).toBe(0);
    expect(body.skipped).toBe(0);

    const runs = await store.listRunsForAutomation(id, { limit: 10, offset: 0 });
    expect(runs.total).toBe(0);
  });

  it("rate-limits once max_runs_per_hour materialized runs exist in the window", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store, { max_runs_per_hour: 2 });

    const now = Date.now();
    await store.insertRun(
      makeRun(id, {
        id: "seed-1",
        status: "completed",
        scheduled_at: now - 1000,
        created_at: now - 1000,
      })
    );
    await store.insertRun(
      makeRun(id, {
        id: "seed-2",
        status: "completed",
        scheduled_at: now - 2000,
        created_at: now - 2000,
      })
    );

    const res = await sendEvent(makeSlackEvent({ text: "please deploy" }));
    const body = await res.json<{ triggered: number; skipped: number }>();
    expect(body.skipped).toBe(1);
    expect(body.triggered).toBe(0);

    const runs = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    const rateLimited = runs.runs.find((r) => r.skip_reason === "rate_limited");
    expect(rateLimited).toBeDefined();
    expect(rateLimited!.status).toBe("skipped");
    // No new materialized run — only the two seeds count.
    expect(runs.runs.filter((r) => r.status !== "skipped")).toHaveLength(2);
  });

  it("does not count prior skipped runs toward the rate limit", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store, { max_runs_per_hour: 2 });

    const now = Date.now();
    // 1 materialized + several skipped (distinct scheduled_at to avoid the idempotency index).
    await store.insertRun(
      makeRun(id, {
        id: "mat-1",
        status: "completed",
        scheduled_at: now - 1000,
        created_at: now - 1000,
      })
    );
    for (let i = 0; i < 4; i++) {
      await store.insertRun(
        makeRun(id, {
          id: `skip-${i}`,
          status: "skipped",
          skip_reason: "rate_limited",
          scheduled_at: now - 100 * (i + 2),
          created_at: now - 100 * (i + 2),
        })
      );
    }

    // Non-skipped count = 1 < 2 → this event should still trigger.
    const event = makeSlackEvent({ text: "deploy now" });
    await sendEvent(event);

    const runs = await store.listRunsForAutomation(id, { limit: 50, offset: 0 });
    const matched = runs.runs.find((r) => r.trigger_key === event.triggerKey);
    expect(matched).toBeDefined();
    expect(matched!.status).not.toBe("skipped");
  });

  it("records a concurrency skip for slack and creates no new materialized run", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-1";
    await store.insertRun(
      makeRun(id, {
        id: "active-1",
        status: "running",
        session_id: "sess-x",
        started_at: Date.now(),
        concurrency_key: concurrencyKey,
        trigger_key: "slack:msg:C1:first",
      })
    );

    const res = await sendEvent(
      makeSlackEvent({ text: "deploy", concurrencyKey, triggerKey: "slack:msg:C1:second" })
    );
    const body = await res.json<{ triggered: number; skipped: number }>();
    expect(body.skipped).toBe(1);
    expect(body.triggered).toBe(0);

    const runs = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    const skip = runs.runs.find((r) => r.skip_reason === "concurrent_run_active");
    expect(skip).toBeDefined();
    expect(skip!.slack_channel).toBe("C1");
  });

  it("dedups a duplicate slack message with the same trigger_key", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const event = makeSlackEvent({
      text: "deploy",
      triggerKey: "slack:msg:C1:dup",
      concurrencyKey: "slack:C1:dup",
    });
    await sendEvent(event);
    const res2 = await sendEvent(event);
    const body2 = await res2.json<{ triggered: number; skipped: number }>();
    expect(body2.skipped).toBe(1);

    const runs = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    expect(runs.runs.filter((r) => r.trigger_key === "slack:msg:C1:dup")).toHaveLength(1);
  });
});
