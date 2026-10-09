import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";

const OWNER = "11111111111111111111111111111111";
const AUTOMATION_ID = "auto-webhook-session";
const SESSION_ID = "session-webhook";

function createScheduler() {
  const prompts = vi.fn(async (request: Request, _sessionId: string) => {
    expect(new URL(request.url).pathname).toBe("/internal/prompt");
    return Response.json({ messageId: "msg-follow-up", status: "queued" });
  });
  const schedulerEnv = createCloudflareEnv(env);
  schedulerEnv.SESSION = (sessionId, request) => prompts(request, sessionId);
  return { scheduler: new Scheduler(env.DB, schedulerEnv, { submit() {} }), prompts };
}

async function seedSessionRun() {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, trigger_type, model, created_by, user_id,
        created_at, updated_at, trigger_config)
     VALUES (?, NULL, 'Card agent', 'Fixture only', 'webhook', 'anthropic/claude-sonnet-4-6',
       ?, ?, ?, ?, ?)`
  )
    .bind(AUTOMATION_ID, OWNER, OWNER, now, now, JSON.stringify({ conditions: [] }))
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, title, owner_team_id, visibility, user_id, status, automation_id, automation_run_id,
        spawn_source, created_at, updated_at)
     VALUES (?, 'Card session', NULL, 'private', ?, 'completed', ?, 'run-webhook', 'automation', ?, ?)`
  )
    .bind(SESSION_ID, OWNER, AUTOMATION_ID, now, now)
    .run();
  const run = makeRunRow(AUTOMATION_ID, {
    id: "run-webhook",
    session_id: SESSION_ID,
    status: "completed",
    completed_at: now,
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
      normalizeWebhookEvent(AUTOMATION_ID, { mode: "iterate", pr: 8262 }, "review-1", "card-42")
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
});
