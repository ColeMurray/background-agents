import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import * as automationRepositories from "../../src/automation/repository";
import { AutomationModelProviderAuthStore } from "../../src/db/automation-model-provider-auth";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { createScheduler } from "../../src/scheduler/factory";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, sqlDatabase } from "./helpers";
import { makeAutomation } from "./invocation-fixtures";
import { fetchRuns } from "./run-helpers";

const AUTOMATION_ID = "auto-retry";
const INIT_FAILURE = "Failed to initialize session DO: 500";
const FIRST_RETRY_DELAY_MS = 2 * 60 * 1000;

function requestPath(input: RequestInfo | URL): string {
  return new URL(
    typeof input === "string" ? input : input instanceof Request ? input.url : input.href
  ).pathname;
}

/** Schedulers whose session Durable Object starts and takes prompts as `behavior` says. */
function sessionStub() {
  const behavior = { initOk: false, promptOk: true };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = requestPath(input);
    if (path === "/internal/init") {
      return behavior.initOk
        ? Response.json({ status: "ok" })
        : new Response("D1 unavailable", { status: 500 });
    }
    if (path === "/internal/prompt") {
      return behavior.promptOk
        ? Response.json({ messageId: "msg-1", status: "queued" })
        : new Response("Unavailable", { status: 503 });
    }
    return new Response("Not Found", { status: 404 });
  });
  const schedulerEnv = createCloudflareEnv({
    ...env,
    SESSION: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace,
  });
  return {
    behavior,
    scheduler: () => createScheduler(env.DB, schedulerEnv, { submit() {} }),
    calls: (path: string) => fetch.mock.calls.filter(([input]) => requestPath(input) === path),
  };
}

const store = () => new AutomationStore(env.DB);

async function onlyRun() {
  const runs = await fetchRuns(AUTOMATION_ID);
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

async function makeRetryDue(runId: string): Promise<void> {
  await env.DB.prepare("UPDATE automation_runs SET retry_at = ? WHERE id = ?")
    .bind(Date.now() - 1, runId)
    .run();
}

async function latestInvocation() {
  const { invocations } = await store().listInvocations(AUTOMATION_ID, { limit: 10, offset: 0 });
  return invocations[0]!;
}

describe.each(["recurring", "one-shot"] as const)("%s scheduled launch retries", (schedule) => {
  async function createOverdueAutomation(overrides: Partial<AutomationRow>): Promise<void> {
    const at = Date.now() - 60_000;
    await store().create(
      makeAutomation({
        id: AUTOMATION_ID,
        next_run_at: at,
        ...(schedule === "one-shot" ? { schedule_cron: null, schedule_once_at: at } : {}),
        ...overrides,
      })
    );
  }

  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits to relaunch a run whose session fails to start, without a failure strike", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });

    const before = Date.now();
    expect(await session.scheduler().tick()).toMatchObject({ processed: 1, failed: 0 });

    const run = await onlyRun();
    expect(run).toMatchObject({
      status: "retrying",
      attempt: 1,
      failure_reason: INIT_FAILURE,
      session_id: null,
      started_at: null,
      completed_at: null,
    });
    if (schedule === "one-shot") {
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({
        enabled: 1,
        next_run_at: null,
      });
    }
    expect(run.retry_at).toBeGreaterThanOrEqual(before + FIRST_RETRY_DELAY_MS);
    expect(run.retry_at).toBeLessThanOrEqual(Date.now() + FIRST_RETRY_DELAY_MS);
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(0);
    expect(await latestInvocation()).toMatchObject({
      status: "retrying",
      completedAt: null,
      runs: [expect.objectContaining({ status: "retrying", attempt: 1, retryAt: run.retry_at })],
    });
  });

  it("relaunches the same run once its wait is over, and its success clears the streak", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2, consecutive_failures: 2 });
    await session.scheduler().tick();
    const waiting = await onlyRun();

    await session.scheduler().tick();
    expect(await onlyRun()).toMatchObject({ status: "retrying", attempt: 1 });
    expect(session.calls("/internal/init")).toHaveLength(1);

    await makeRetryDue(waiting.id);
    session.behavior.initOk = true;
    await session.scheduler().tick();

    const relaunched = await onlyRun();
    expect(relaunched).toMatchObject({
      id: waiting.id,
      status: "running",
      attempt: 2,
      retry_at: null,
      failure_reason: null,
      session_id: expect.any(String),
    });
    expect(session.calls("/internal/prompt")).toHaveLength(1);

    await session.scheduler().runComplete({
      automationId: AUTOMATION_ID,
      runId: relaunched.id,
      sessionId: relaunched.session_id!,
      messageId: "msg-1",
      success: true,
    });
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(0);
    expect(await latestInvocation()).toMatchObject({
      status: "completed",
      runs: [expect.objectContaining({ status: "completed", attempt: 2 })],
    });
    if (schedule === "one-shot") {
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({ enabled: 0, next_run_at: null });
      expect((await store().list({ limit: 10 })).automations).toHaveLength(0);
      await session.scheduler().tick();
      expect(await onlyRun()).toMatchObject({ id: waiting.id, status: "completed", attempt: 2 });
      expect((await store().listInvocations(AUTOMATION_ID, { limit: 10, offset: 0 })).total).toBe(
        1
      );
    }
  });

  it("doubles the wait after each failed launch", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });
    await session.scheduler().tick();
    await makeRetryDue((await onlyRun()).id);

    const before = Date.now();
    await session.scheduler().tick();

    const run = await onlyRun();
    expect(run).toMatchObject({ status: "retrying", attempt: 2, failure_reason: INIT_FAILURE });
    expect(run.retry_at).toBeGreaterThanOrEqual(before + 2 * FIRST_RETRY_DELAY_MS);
    expect(run.retry_at).toBeLessThanOrEqual(Date.now() + 2 * FIRST_RETRY_DELAY_MS);
  });

  it("fails with the last launch error and one strike once its retries run out", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 1 });
    await session.scheduler().tick();
    await makeRetryDue((await onlyRun()).id);

    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({
      status: "failed",
      attempt: 2,
      failure_reason: INIT_FAILURE,
      retry_at: null,
      completed_at: expect.any(Number),
    });
    expect(session.calls("/internal/init")).toHaveLength(2);
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(1);
    expect(await latestInvocation()).toMatchObject({ status: "failed" });
    if (schedule === "one-shot") {
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({ enabled: 0, next_run_at: null });
      expect((await store().list({ limit: 10 })).automations).toHaveLength(1);
    }
  });

  it("fails as before when the automation allows no retries", async () => {
    const session = sessionStub();
    await createOverdueAutomation({});

    expect(await session.scheduler().tick()).toMatchObject({ processed: 0, failed: 1 });

    expect(await onlyRun()).toMatchObject({ status: "failed", attempt: 1, retry_at: null });
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(1);
  });

  it("does not retry a launch whose prompt was sent", async () => {
    const session = sessionStub();
    session.behavior.initOk = true;
    session.behavior.promptOk = false;
    await createOverdueAutomation({ max_retries: 2 });

    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({
      status: "failed",
      failure_reason: "Prompt enqueue failed with status 503",
      retry_at: null,
    });
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(1);
  });

  it("does not retry a manual run", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });

    await expect(session.scheduler().trigger(AUTOMATION_ID, "user-1")).rejects.toThrow(
      "Failed to trigger automation"
    );

    expect(await onlyRun()).toMatchObject({ status: "failed", retry_at: null });
  });

  it("holds the automation while a run waits without admitting another launch", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });
    await session.scheduler().tick();
    if (schedule === "recurring") {
      await env.DB.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .bind(Date.now() - 1, AUTOMATION_ID)
        .run();
    }

    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({ status: "retrying" });
    expect(await latestInvocation()).toMatchObject(
      schedule === "recurring"
        ? { status: "skipped", skipReason: "concurrent_run_active" }
        : { status: "retrying" }
    );
    expect(session.calls("/internal/init")).toHaveLength(1);
  });

  it.each([
    ["pausing the automation", () => store().pause(AUTOMATION_ID)],
    ["deleting the automation", () => store().softDelete(AUTOMATION_ID)],
    ["removing its retries", () => store().update(AUTOMATION_ID, { max_retries: 0 })],
  ])("withdraws a waiting retry on the next tick after %s", async (_, withdraw) => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });
    await session.scheduler().tick();
    expect(await onlyRun()).toMatchObject({ status: "retrying" });

    await withdraw();
    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({
      status: "failed",
      failure_reason: INIT_FAILURE,
      retry_at: null,
      completed_at: expect.any(Number),
    });
    expect(session.calls("/internal/init")).toHaveLength(1);
  });

  it("relaunches a due retry exactly once across concurrent ticks", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });
    await session.scheduler().tick();
    await makeRetryDue((await onlyRun()).id);
    session.behavior.initOk = true;

    await Promise.all([session.scheduler().tick(), session.scheduler().tick()]);

    expect(await onlyRun()).toMatchObject({ status: "running", attempt: 2 });
    expect(session.calls("/internal/init")).toHaveLength(2);
    expect(session.calls("/internal/prompt")).toHaveLength(1);
  });

  it("does not claim a retry from a copy read before another tick relaunched it", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 3 });
    await session.scheduler().tick();
    const stale = await onlyRun();
    await makeRetryDue(stale.id);
    await session.scheduler().tick();
    await makeRetryDue(stale.id);

    expect(await store().claimRetry(stale, Date.now())).toBeNull();
    expect(await store().claimRetry(await onlyRun(), Date.now())).toMatchObject({ attempt: 3 });
  });

  it("counts a sibling's failure only once the run waiting to retry settles", async () => {
    vi.spyOn(automationRepositories, "resolveAutomationRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((requested, index) =>
          requested.repo_name === "gone"
            ? { requested, error: "Repository is not accessible", repository: null }
            : {
                requested,
                error: null,
                repository: {
                  repoOwner: requested.repo_owner,
                  repoName: requested.repo_name,
                  repoId: 100 + index,
                  baseBranch: "main",
                },
              }
        )
    );
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2, consecutive_failures: 4 });
    await sqlDatabase(env.DB).batch(
      store().bindRepositoryInserts(
        AUTOMATION_ID,
        [
          { repo_owner: "acme", repo_name: "app", repo_id: null, base_branch: null },
          { repo_owner: "acme", repo_name: "gone", repo_id: null, base_branch: null },
        ],
        Date.now()
      )
    );

    await session.scheduler().tick();

    const byRepo = async () =>
      Object.fromEntries((await fetchRuns(AUTOMATION_ID)).map((run) => [run.repo_name, run]));
    expect(await byRepo()).toMatchObject({
      app: { status: "retrying" },
      gone: { status: "failed" },
    });
    expect(await store().getById(AUTOMATION_ID)).toMatchObject({
      enabled: 1,
      consecutive_failures: 4,
    });

    await makeRetryDue((await byRepo()).app!.id);
    session.behavior.initOk = true;
    await session.scheduler().tick();
    const relaunched = (await byRepo()).app!;
    expect(relaunched).toMatchObject({ status: "running", attempt: 2 });
    await session.scheduler().runComplete({
      automationId: AUTOMATION_ID,
      runId: relaunched.id,
      sessionId: relaunched.session_id!,
      messageId: "msg-1",
      success: true,
    });

    expect(await store().getById(AUTOMATION_ID)).toMatchObject({
      enabled: 0,
      consecutive_failures: 5,
    });
    expect(await latestInvocation()).toMatchObject({ status: "partial_failed" });
  });

  it.each([
    [
      "a model its harness cannot run",
      () =>
        createOverdueAutomation({
          max_retries: 2,
          harness: "codex",
          model: "anthropic/claude-sonnet-4-6",
        }),
    ],
    [
      "a pinned provider account that was archived",
      async () => {
        const accountId = "0".repeat(32);
        const accounts = new ModelProviderAccountStore(env.DB);
        await accounts.create({ id: accountId, provider: "openai", displayName: "OpenAI" });
        await createOverdueAutomation({ max_retries: 2 });
        await sqlDatabase(env.DB).batch(
          new AutomationModelProviderAuthStore(env.DB).bindReplace(
            AUTOMATION_ID,
            { openai: { mode: "provider_account", accountId } },
            Date.now()
          )
        );
        await accounts.archive(accountId, null);
      },
    ],
  ])("does not retry %s", async (_, configure) => {
    const session = sessionStub();
    await configure();

    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({ status: "failed", retry_at: null });
    expect(session.calls("/internal/init")).toHaveLength(0);
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(1);
  });

  it("re-checks the owner's authorization before relaunching", async () => {
    const session = sessionStub();
    await createOverdueAutomation({ max_retries: 2 });
    await session.scheduler().tick();
    await makeRetryDue((await onlyRun()).id);
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
    )
      .bind("user-1")
      .run();
    session.behavior.initOk = true;

    await session.scheduler().tick();

    expect(await onlyRun()).toMatchObject({
      status: "unauthorized",
      attempt: 2,
      failure_reason: "execution_authorization_denied",
    });
    expect(session.calls("/internal/init")).toHaveLength(1);
    expect((await store().getById(AUTOMATION_ID))!.consecutive_failures).toBe(0);
  });
  if (schedule === "one-shot") {
    it("withdraws the old slot's retry when the one-shot is rescheduled", async () => {
      const session = sessionStub();
      await createOverdueAutomation({ max_retries: 2 });
      await session.scheduler().tick();
      const future = Date.now() + 3_600_000;
      await store().update(AUTOMATION_ID, { schedule_once_at: future });
      await session.scheduler().tick();
      expect(await onlyRun()).toMatchObject({ status: "failed", retry_at: null });
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({
        enabled: 1,
        schedule_once_at: future,
        next_run_at: future,
      });
      expect(session.calls("/internal/init")).toHaveLength(1);
    });

    it("repairs a missed disable after a terminal transition", async () => {
      const session = sessionStub();
      session.behavior.initOk = true;
      await createOverdueAutomation({ max_retries: 2 });
      await session.scheduler().tick();
      const running = await onlyRun();
      // Simulate a crash after the terminal write, before invocation accounting.
      await store().updateRun(running.id, { status: "completed", completed_at: Date.now() });
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({ enabled: 1, next_run_at: null });
      await session.scheduler().tick();
      expect(await store().getById(AUTOMATION_ID)).toMatchObject({ enabled: 0, next_run_at: null });
      expect(session.calls("/internal/init")).toHaveLength(1);
    });
  }
});
