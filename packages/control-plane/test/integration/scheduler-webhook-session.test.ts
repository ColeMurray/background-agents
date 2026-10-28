import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore } from "../../src/db/automation-store";
import { createScheduler as createAutomationScheduler } from "../../src/scheduler/factory";
import { SessionFollowUpRefusedError } from "../../src/scheduler/contracts";
import { firstPromptRequestId } from "../../src/scheduler/session-prompt";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedActiveUser } from "./helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";

const OWNER = "11111111111111111111111111111111";
const AUTOMATION_ID = "auto-webhook-session";
const SESSION_ID = "session-webhook";

/** A stand-in session that has not queued the run's first prompt under its request id. */
function createScheduler(promptDelayMs = 0, promptGate?: Promise<void>) {
  const prompts = vi.fn(async (request: Request, _sessionId: string) => {
    expect(new URL(request.url).pathname).toBe("/internal/prompt");
    if (promptGate) await promptGate;
    if (promptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, promptDelayMs));
    return Response.json({ messageId: "msg-follow-up", status: "queued" });
  });
  const schedulerEnv = createCloudflareEnv(env);
  schedulerEnv.SESSION = async (sessionId, request) =>
    new URL(request.url).pathname === "/internal/prompt-request"
      ? Response.json({ queued: false })
      : prompts(request, sessionId);
  return { scheduler: createAutomationScheduler(env.DB, schedulerEnv, { submit() {} }), prompts };
}

async function seedAutomation(now: number) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, trigger_type, model, created_by, user_id,
        created_at, updated_at, trigger_config)
     VALUES (?, NULL, 'Card agent', 'Fixture only', 'webhook', 'anthropic/claude-sonnet-4-6',
       ?, ?, ?, ?, ?)`
  )
    .bind(AUTOMATION_ID, OWNER, OWNER, now, now, JSON.stringify({ conditions: [] }))
    .run();
}

async function seedSessionRun({ runCreatedAt = Date.now(), sessionUpdatedAt = Date.now() } = {}) {
  await seedAutomation(runCreatedAt);
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, title, owner_team_id, visibility, user_id, status, automation_id, automation_run_id,
        spawn_source, created_at, updated_at)
     VALUES (?, 'Card session', NULL, 'private', ?, 'completed', ?, 'run-webhook', 'automation', ?, ?)`
  )
    .bind(SESSION_ID, OWNER, AUTOMATION_ID, runCreatedAt, sessionUpdatedAt)
    .run();
  const run = makeRunRow(AUTOMATION_ID, {
    id: "run-webhook",
    session_id: SESSION_ID,
    status: "completed",
    created_at: runCreatedAt,
    completed_at: runCreatedAt,
  });
  await seedRun(run, { concurrencyKey: "webhook:session:card-42" });
  return run;
}

describe("Scheduler webhook sessionKey (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("queues a delivery with a known sessionKey on that run's session as its executor", async () => {
    const run = await seedSessionRun();
    const { scheduler, prompts } = createScheduler();

    const result = await scheduler.event(
      normalizeWebhookEvent(
        AUTOMATION_ID,
        { mode: "iterate", pr: 8262 },
        { idempotencyKey: "review-1", sessionKey: "card-42" }
      )
    );

    expect(result).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
      invocationIds: [run.invocation_id],
    });
    expect(prompts).toHaveBeenCalledTimes(1);
    expect(prompts.mock.calls[0][1]).toBe(SESSION_ID);
    const body = (await prompts.mock.calls[0][0].json()) as Record<string, unknown>;
    expect(body).toMatchObject({ source: "automation", authorId: OWNER, canonicalUserId: OWNER });
    expect(body.callbackContext).toBeUndefined();
    expect(body.content).toContain('"pr": 8262');
    expect(await fetchRuns(AUTOMATION_ID)).toEqual([
      expect.objectContaining({ id: "run-webhook", status: "completed" }),
    ]);
  });

  it("continues a session started over 7 days ago that was active since", async () => {
    const run = await seedSessionRun({ runCreatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000 });
    const { scheduler, prompts } = createScheduler();

    const result = await scheduler.event(
      normalizeWebhookEvent(AUTOMATION_ID, { step: "later" }, { sessionKey: "card-42" })
    );

    expect(result).toMatchObject({ steered: 1, invocationIds: [run.invocation_id] });
    expect(prompts.mock.calls[0]?.[1]).toBe(SESSION_ID);
  });

  it("leases an idempotency key before concurrent deliveries reach different sessions", async () => {
    const first = await seedSessionRun();
    const secondSessionId = "session-webhook-second";
    await env.DB.prepare(
      `INSERT INTO sessions
         (id, title, owner_team_id, visibility, user_id, status, automation_id, automation_run_id,
          spawn_source, created_at, updated_at)
       VALUES (?, 'Second card session', NULL, 'private', ?, 'completed', ?, 'run-webhook-second',
         'automation', ?, ?)`
    )
      .bind(secondSessionId, OWNER, AUTOMATION_ID, Date.now(), Date.now())
      .run();
    const second = makeRunRow(AUTOMATION_ID, {
      id: "run-webhook-second",
      session_id: secondSessionId,
      status: "completed",
      completed_at: Date.now(),
    });
    await seedRun(second, { concurrencyKey: "webhook:session:card-43" });
    const { scheduler, prompts } = createScheduler(25);

    const deliveries = await Promise.allSettled([
      scheduler.event(
        normalizeWebhookEvent(
          AUTOMATION_ID,
          { step: "same" },
          { idempotencyKey: "event-same", sessionKey: "card-42" }
        )
      ),
      scheduler.event(
        normalizeWebhookEvent(
          AUTOMATION_ID,
          { step: "same" },
          { idempotencyKey: "event-same", sessionKey: "card-43" }
        )
      ),
    ]);

    expect(prompts).toHaveBeenCalledTimes(1);
    expect(deliveries.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const [refused] = deliveries.filter(({ status }) => status === "rejected");
    expect(refused).toMatchObject({ reason: expect.any(SessionFollowUpRefusedError) });
    const receipt = await env.DB.prepare(
      `SELECT invocation_id, accepted_at FROM automation_follow_up_receipts
       WHERE automation_id = ? AND trigger_key = 'webhook:idem:event-same'`
    )
      .bind(AUTOMATION_ID)
      .first<{ invocation_id: string; accepted_at: number | null }>();
    expect([first.invocation_id, second.invocation_id]).toContain(receipt?.invocation_id);
    expect(receipt?.accepted_at).toEqual(expect.any(Number));
  });

  it("leases an idempotency key before a same-key delivery can start a new invocation", async () => {
    const run = await seedSessionRun();
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const { scheduler, prompts } = createScheduler(0, promptGate);
    const continuing = scheduler.event(
      normalizeWebhookEvent(
        AUTOMATION_ID,
        { step: "same" },
        { idempotencyKey: "event-same", sessionKey: "card-42" }
      )
    );
    await vi.waitFor(() => expect(prompts).toHaveBeenCalledTimes(1));

    const starting = scheduler.event(
      normalizeWebhookEvent(
        AUTOMATION_ID,
        { step: "same" },
        { idempotencyKey: "event-same", sessionKey: "unknown-card" }
      )
    );

    await expect(starting).rejects.toBeInstanceOf(SessionFollowUpRefusedError);
    releasePrompt();
    await expect(continuing).resolves.toMatchObject({ steered: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM automation_invocations WHERE automation_id = ?"
      )
        .bind(AUTOMATION_ID)
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT invocation_id, accepted_at FROM automation_follow_up_receipts
         WHERE automation_id = ? AND trigger_key = 'webhook:idem:event-same'`
      )
        .bind(AUTOMATION_ID)
        .first<{ invocation_id: string; accepted_at: number | null }>()
    ).toEqual({ invocation_id: run.invocation_id, accepted_at: expect.any(Number) });
  });

  it.each([
    { marker: "recorded", recordMarker: true },
    { marker: "never recorded (the worker died or the write failed)", recordMarker: false },
  ])(
    "holds a follow-up that races the run's launch until its first prompt is queued, with the marker $marker",
    async ({ recordMarker }) => {
      const sessionId = `session-launching-${Date.now()}`;
      await seedAutomation(Date.now());
      const run = makeRunRow(AUTOMATION_ID, { id: "run-launching", status: "starting" });
      await seedRun(run, { concurrencyKey: "webhook:session:card-42" });
      const store = new AutomationStore(env.DB);
      // The launch has claimed its session; the session itself is not created yet.
      expect(await store.claimRunSession(run.id, sessionId, Date.now(), Date.now() + 60_000)).toBe(
        true
      );
      const scheduler = createAutomationScheduler(env.DB, createCloudflareEnv(env), {
        submit() {},
      });

      let followUp: unknown;
      const { stub } = await initNamedSession(
        sessionId,
        { userId: OWNER, canonicalUserId: OWNER, spawnSource: "automation" },
        async () => {
          followUp = await scheduler.event(
            normalizeWebhookEvent(AUTOMATION_ID, { step: "FOLLOW-UP" }, { sessionKey: "card-42" })
          );
        }
      );
      const messages = async () =>
        (
          await queryDO<{ content: string }>(
            stub,
            "SELECT content FROM messages ORDER BY created_at, rowid"
          )
        ).map(({ content }) => (content.includes("FOLLOW-UP") ? "FOLLOW-UP" : content));

      expect(followUp).toEqual({
        triggered: 0,
        skipped: 0,
        steered: 1,
        invocationIds: [run.invocation_id],
      });
      expect(await messages()).toEqual([]);

      // The launch queues the run's own first prompt under its stable request id. A
      // missed release is picked up by the tick's held-prompt sweep, which asks the
      // session when the run's own record of that prompt is missing.
      await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "INSTRUCTIONS",
          authorId: OWNER,
          source: "automation",
          clientRequestId: firstPromptRequestId(run.id),
        }),
      });
      if (recordMarker) await store.markRunFirstPromptQueued(run.id);
      await env.DB.prepare("UPDATE automation_run_held_prompts SET retry_at = ?")
        .bind(Date.now() - 1)
        .run();
      await scheduler.tick();

      expect(await messages()).toEqual(["INSTRUCTIONS", "FOLLOW-UP"]);
      expect(await store.getHeldPrompts(run.id)).toEqual([]);
      expect(
        await env.DB.prepare("SELECT first_prompt_pending FROM automation_runs WHERE id = ?")
          .bind(run.id)
          .first<{ first_prompt_pending: number }>()
      ).toEqual({ first_prompt_pending: 0 });
    }
  );

  async function seedLaunchingRun() {
    await seedAutomation(Date.now());
    await env.DB.prepare(
      `INSERT INTO sessions
         (id, title, owner_team_id, visibility, user_id, status, automation_id, automation_run_id,
          spawn_source, created_at, updated_at)
       VALUES (?, 'Card session', NULL, 'private', ?, 'created', ?, 'run-launching', 'automation', ?, ?)`
    )
      .bind(SESSION_ID, OWNER, AUTOMATION_ID, Date.now(), Date.now())
      .run();
    const run = makeRunRow(AUTOMATION_ID, { id: "run-launching", status: "starting" });
    await seedRun(run, { concurrencyKey: "webhook:session:card-42" });
    const store = new AutomationStore(env.DB);
    await store.claimRunSession(run.id, SESSION_ID, Date.now(), Date.now() + 60_000);
    return { run, store };
  }

  const delivery = (step: string) =>
    normalizeWebhookEvent(
      AUTOMATION_ID,
      { step },
      { idempotencyKey: `event-${step}`, sessionKey: "card-42" }
    );

  it("holds a delivery retried before the run's first prompt once and skips the retry", async () => {
    const { run, store } = await seedLaunchingRun();
    const { scheduler, prompts } = createScheduler();

    expect(await scheduler.event(delivery("A"))).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
      invocationIds: [run.invocation_id],
    });
    expect(await scheduler.event(delivery("A"))).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
      invocationIds: [run.invocation_id],
    });

    expect(await store.getHeldPrompts(run.id)).toHaveLength(1);
    expect(prompts).not.toHaveBeenCalled();
  });

  it("queues a delivery that arrives while held ones await release behind them", async () => {
    const { run, store } = await seedLaunchingRun();
    const { scheduler, prompts } = createScheduler();

    await scheduler.event(delivery("A"));
    // The run's first prompt is queued, but A has not been released yet.
    await store.markRunFirstPromptQueued(run.id);
    expect(await scheduler.event(delivery("B"))).toMatchObject({ steered: 1 });
    expect(prompts).not.toHaveBeenCalled();

    // A missed release is picked up by the tick's sweep, in order.
    await env.DB.prepare("UPDATE automation_run_held_prompts SET retry_at = ?")
      .bind(Date.now() - 1)
      .run();
    await scheduler.tick();

    const steps = await Promise.all(
      prompts.mock.calls.map(async ([request]) => {
        const { content } = (await request.json()) as { content: string };
        return content.match(/"step": "(\w)"/)?.[1];
      })
    );
    expect(steps).toEqual(["A", "B"]);
    expect(await store.getHeldPrompts(run.id)).toEqual([]);
  });

  it("releases held deliveries once the run completes, if the launch never recorded its first prompt", async () => {
    const { run, store } = await seedLaunchingRun();
    const { scheduler, prompts } = createScheduler();

    await scheduler.event(delivery("A"));
    // The run's record of its first prompt is missing and the session cannot confirm
    // it either (this stand-in session does not know its request id), so A stays held.
    await env.DB.prepare("UPDATE automation_run_held_prompts SET retry_at = ?")
      .bind(Date.now() - 1)
      .run();
    await scheduler.tick();
    expect(prompts).not.toHaveBeenCalled();

    await env.DB.prepare("UPDATE automation_run_held_prompts SET retry_at = ?")
      .bind(Date.now() - 1)
      .run();
    await scheduler.runComplete({
      automationId: AUTOMATION_ID,
      runId: run.id,
      sessionId: SESSION_ID,
      messageId: "msg-first",
      success: true,
    });
    await scheduler.tick();

    expect(prompts).toHaveBeenCalledTimes(1);
    const { content } = (await prompts.mock.calls[0]![0].json()) as { content: string };
    expect(content).toContain('"step": "A"');
    expect(await store.getHeldPrompts(run.id)).toEqual([]);
  });

  it("drops held deliveries when the run fails before claiming a session", async () => {
    await seedAutomation(Date.now());
    const run = makeRunRow(AUTOMATION_ID, { id: "run-pre-claim-failure", status: "starting" });
    await seedRun(run, { concurrencyKey: "webhook:session:card-42" });
    const store = new AutomationStore(env.DB);
    const { scheduler } = createScheduler();

    expect(await scheduler.event(delivery("A"))).toMatchObject({ steered: 1 });
    expect(await store.getHeldPrompts(run.id)).toHaveLength(1);

    expect(
      await store.updateRun(run.id, {
        status: "failed",
        failure_reason: "Provider authorization failed",
        completed_at: Date.now(),
      })
    ).toBe(true);
    await env.DB.prepare("UPDATE automation_run_held_prompts SET retry_at = ?")
      .bind(Date.now() - 1)
      .run();

    await scheduler.tick();

    expect(await store.getHeldPrompts(run.id)).toEqual([]);
  });
});
