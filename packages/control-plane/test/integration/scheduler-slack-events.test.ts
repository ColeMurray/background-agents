import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { sqlDatabase } from "./helpers";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import { cleanD1Tables } from "./cleanup";
import { Scheduler } from "../../src/scheduler/scheduler";
import type { Env } from "../../src/types";
import { makeRunRow, seedRun, fetchRuns } from "./run-helpers";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Slack triage",
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

function sendEvent(event: SlackAutomationEvent) {
  return new Scheduler(env.DB, env as Env, { submit() {} }).event(event);
}

/** Create a watched slack_event automation (channel C1, text_match contains "deploy"). */
async function seedSlackAutomation(
  store: AutomationStore,
  overrides?: Partial<AutomationRow>
): Promise<string> {
  const id = `auto-slack-${Math.random().toString(36).slice(2, 8)}`;
  await store.create(makeAutomation({ id, ...overrides }));
  const channels = new SlackChannelStore(env.DB);
  await sqlDatabase(env.DB).batch(channels.bindChannelStatements(id, ["C1"]));
  return id;
}

/** The automation's invocations, newest first. */
async function fetchInvocations(store: AutomationStore, automationId: string) {
  const { invocations } = await store.listInvocations(automationId, { limit: 20, offset: 0 });
  return invocations;
}

describe("Scheduler slack event handling (integration)", () => {
  beforeEach(cleanD1Tables);

  it("triggers a matching slack automation and records thread coordinates", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const event = makeSlackEvent({ text: "please deploy the api" });
    const result = await sendEvent(event);
    expect(result.triggered).toBe(1);

    const runs = await fetchRuns(id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // The firing keys and message coordinates live on the invocation.
    const invocation = await store.getInvocationById(runs[0]!.invocation_id);
    expect(invocation!.trigger_key).toBe(event.triggerKey);
    const metadata = JSON.parse(invocation!.trigger_metadata!);
    expect(metadata.channel).toBe("C1");
    expect(metadata.messageTs).toBe(event.ts);
  });

  it("does not trigger when the text_match condition fails", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const result = await sendEvent(makeSlackEvent({ text: "good morning team" }));
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

    expect(await fetchRuns(id)).toHaveLength(0);
  });

  it("does not trigger when the channel is not watched (no candidate)", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // Event in an unwatched channel — the join table returns no candidate.
    const result = await sendEvent(
      makeSlackEvent({
        channelId: "C2",
        text: "please deploy",
        triggerKey: "slack:msg:C2:1",
        concurrencyKey: "slack:C2:1",
      })
    );
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0 });

    expect(await fetchRuns(id)).toHaveLength(0);
  });

  it("falls back to a concurrency skip when the active run has no session to steer", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // A run still in "starting" has not created its session yet, so a follow-up
    // has nothing to steer and is dropped with the "already active" notice.
    // (The steering path — where the active run has a session_id — is covered in
    // the scheduler unit tests with a mocked session, so it doesn't attempt a
    // real sandbox spawn here.)
    const concurrencyKey = "slack:C1:thread-1";
    // The active run's concurrency key lives on its invocation.
    const activeInvId = "inv-active-1";
    await env.DB.prepare(
      `INSERT INTO automation_invocations
         (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
          trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
       VALUES (?, ?, 'event', NULL, 'slack:msg:C1:first', ?, NULL, NULL, NULL, ?, ?)`
    )
      .bind(activeInvId, id, concurrencyKey, Date.now(), Date.now())
      .run();
    await seedRun(
      makeRunRow(id, {
        id: "active-1",
        invocation_id: activeInvId,
        status: "starting",
        session_id: null,
      })
    );

    const result = await sendEvent(
      makeSlackEvent({ text: "deploy", concurrencyKey, triggerKey: "slack:msg:C1:second" })
    );
    expect(result).toEqual({ triggered: 0, skipped: 1, steered: 0 });

    // The skip is a childless invocation carrying the message coordinates.
    const invocations = await fetchInvocations(store, id);
    const skip = invocations.find(
      (invocation) => invocation.skipReason === "concurrent_run_active"
    );
    expect(skip).toBeDefined();
    expect(skip!.status).toBe("skipped");
    expect(skip!.runs).toHaveLength(0);
    const invocationRow = await store.getInvocationById(skip!.id);
    expect(JSON.parse(invocationRow!.trigger_metadata!).channel).toBe("C1");
  });

  it("steers the running session on a follow-up reply instead of dropping it", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-steer";
    // Root message triggers the run and creates its session.
    const rootResult = await sendEvent(
      makeSlackEvent({ text: "deploy the api", concurrencyKey, triggerKey: "slack:msg:C1:root" })
    );
    expect(rootResult.triggered).toBe(1);

    // A follow-up reply in the same thread (same concurrency key, new message)
    // is routed to the running session as a steering turn — not skipped.
    const followResult = await sendEvent(
      makeSlackEvent({
        text: "also update the changelog",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply",
      })
    );
    expect(followResult).toEqual({ triggered: 0, skipped: 0, steered: 1 });

    // No concurrency-skip invocation recorded — the follow-up was steered.
    const invocations = await fetchInvocations(store, id);
    expect(
      invocations.find((invocation) => invocation.skipReason === "concurrent_run_active")
    ).toBeUndefined();
  });

  it("continues the same session on a reply after the run has completed", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-done";
    // Root message triggers the run and creates its session.
    const rootResult = await sendEvent(
      makeSlackEvent({
        text: "deploy the api",
        concurrencyKey,
        triggerKey: "slack:msg:C1:root-done",
      })
    );
    expect(rootResult.triggered).toBe(1);

    // Simulate the run finishing. Its session stays steerable within the window,
    // just like an @mention thread after a turn completes.
    const afterRoot = await fetchRuns(id);
    expect(afterRoot).toHaveLength(1);
    const rootRun = afterRoot[0]!;
    expect(rootRun.session_id).toBeTruthy();
    await store.updateRun(rootRun.id, { status: "completed", completed_at: Date.now() });

    // A reply after completion — with text that does NOT match the trigger
    // conditions — still continues the same session, proving the steer bypasses
    // both condition matching and the run-status filter.
    const followResult = await sendEvent(
      makeSlackEvent({
        text: "thanks! can you also bump the version?",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply-done",
      })
    );
    expect(followResult).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
    });

    // The reply created no new run and recorded no skip — it reused the
    // completed run's session. Exactly one materialized run remains.
    const afterReply = await fetchRuns(id);
    expect(afterReply).toHaveLength(1);
    const invocations = await fetchInvocations(store, id);
    expect(
      invocations.find((invocation) => invocation.skipReason === "concurrent_run_active")
    ).toBeUndefined();
    expect(invocations).toHaveLength(1);
  });
});
