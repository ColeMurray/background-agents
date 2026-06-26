import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
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
    target_mode: "no_repository",
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
  await new SlackChannelStore(env.DB).setSlackChannels(id, ["C1"]);
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
    const metadata = JSON.parse(run.trigger_run_metadata!);
    expect(metadata.channel).toBe("C1");
    expect(metadata.messageTs).toBe(event.ts);
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

  it("falls back to a concurrency skip when the active run has no session to steer", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // A run still in "starting" has not created its session yet, so a follow-up
    // has nothing to steer and is dropped with the "already active" notice.
    // (The steering path — where the active run has a session_id — is covered in
    // the SchedulerDO unit tests with a mocked session, so it doesn't attempt a
    // real sandbox spawn here.)
    const concurrencyKey = "slack:C1:thread-1";
    await store.insertRun(
      makeRun(id, {
        id: "active-1",
        status: "starting",
        session_id: null,
        concurrency_key: concurrencyKey,
        trigger_key: "slack:msg:C1:first",
      })
    );

    const res = await sendEvent(
      makeSlackEvent({ text: "deploy", concurrencyKey, triggerKey: "slack:msg:C1:second" })
    );
    const body = await res.json<{ triggered: number; skipped: number; steered: number }>();
    expect(body.skipped).toBe(1);
    expect(body.triggered).toBe(0);
    expect(body.steered).toBe(0);

    const runs = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    const skip = runs.runs.find((r) => r.skip_reason === "concurrent_run_active");
    expect(skip).toBeDefined();
    expect(JSON.parse(skip!.trigger_run_metadata!).channel).toBe("C1");
  });

  it("steers the running session on a follow-up reply instead of dropping it", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-steer";
    // Root message triggers the run and creates its session.
    const rootRes = await sendEvent(
      makeSlackEvent({ text: "deploy the api", concurrencyKey, triggerKey: "slack:msg:C1:root" })
    );
    const rootBody = await rootRes.json<{ triggered: number }>();
    expect(rootBody.triggered).toBe(1);

    // A follow-up reply in the same thread (same concurrency key, new message)
    // is routed to the running session as a steering turn — not skipped.
    const followRes = await sendEvent(
      makeSlackEvent({
        text: "also update the changelog",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply",
      })
    );
    const followBody = await followRes.json<{
      triggered: number;
      skipped: number;
      steered: number;
    }>();
    expect(followBody).toEqual({ triggered: 0, skipped: 0, steered: 1 });

    // No concurrency-skip row recorded — the follow-up was steered, not dropped.
    const runs = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    expect(runs.runs.find((r) => r.skip_reason === "concurrent_run_active")).toBeUndefined();
  });

  it("continues the same session on a reply after the run has completed", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-done";
    // Root message triggers the run and creates its session.
    const rootRes = await sendEvent(
      makeSlackEvent({
        text: "deploy the api",
        concurrencyKey,
        triggerKey: "slack:msg:C1:root-done",
      })
    );
    expect((await rootRes.json<{ triggered: number }>()).triggered).toBe(1);

    // Simulate the run finishing. Its session stays steerable within the window,
    // just like an @mention thread after a turn completes.
    const afterRoot = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    const rootRun = afterRoot.runs.find((r) => r.trigger_key === "slack:msg:C1:root-done")!;
    expect(rootRun.session_id).toBeTruthy();
    await store.updateRun(rootRun.id, { status: "completed", completed_at: Date.now() });

    // A reply after completion — with text that does NOT match the trigger
    // conditions — still continues the same session, proving the steer bypasses
    // both condition matching and the run-status filter.
    const followRes = await sendEvent(
      makeSlackEvent({
        text: "thanks! can you also bump the version?",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply-done",
      })
    );
    const followBody = await followRes.json<{
      triggered: number;
      skipped: number;
      steered: number;
    }>();
    expect(followBody).toEqual({ triggered: 0, skipped: 0, steered: 1 });

    // The reply created no new run and recorded no skip — it reused the completed
    // run's session. Exactly one materialized run remains (the completed root).
    const afterReply = await store.listRunsForAutomation(id, { limit: 20, offset: 0 });
    expect(
      afterReply.runs.find((r) => r.trigger_key === "slack:msg:C1:reply-done")
    ).toBeUndefined();
    expect(afterReply.runs.find((r) => r.skip_reason === "concurrent_run_active")).toBeUndefined();
    expect(afterReply.runs.filter((r) => r.trigger_key !== null)).toHaveLength(1);
  });
});
