import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore, type AutomationRunRow } from "../../src/db/automation-store";
import { createScheduler as createAutomationScheduler } from "../../src/scheduler/factory";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";

const OWNER = "11111111111111111111111111111111";

function createScheduler() {
  const schedulerEnv = createCloudflareEnv(env);
  schedulerEnv.SCM_PROVIDER = "gitlab";
  // Exercise real D1 session creation and scheduler admission; stand in only for
  // the session runtime, so these tests never start an external sandbox.
  const runtime = vi.fn(async (_sessionId: string, request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/init") return Response.json({ status: "created" });
    if (path === "/internal/prompt")
      return Response.json({ messageId: "msg-first", status: "queued" });
    throw new Error(`Unexpected session runtime call: ${path}`);
  });
  schedulerEnv.SESSION = runtime;
  return { scheduler: createAutomationScheduler(env.DB, schedulerEnv, { submit() {} }), runtime };
}

async function createOneShot(id: string, at: number, createdAt = Date.now()) {
  const store = new AutomationStore(env.DB);
  await store.create(
    makeAutomation({
      id,
      user_id: OWNER,
      created_by: OWNER,
      schedule_cron: null,
      schedule_once_at: at,
      next_run_at: at,
      created_at: createdAt,
    })
  );
  return store;
}

describe("one-shot scheduled automations (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits until its time, launches one session with the instructions, and preserves completed history", async () => {
    const at = Date.now() + 60_000;
    const store = await createOneShot("once", at);
    const { scheduler, runtime } = createScheduler();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at - 1);
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(runtime).not.toHaveBeenCalled();
    expect(await fetchRuns("once")).toHaveLength(0);

    clock.mockReturnValue(at);
    expect(await scheduler.tick()).toEqual({ processed: 1, skipped: 0, failed: 0 });
    const [run] = await fetchRuns("once");
    expect(run).toMatchObject({
      status: "running",
      scheduled_at: at,
      session_id: expect.any(String),
    });
    expect(await store.getById("once")).toMatchObject({
      enabled: 1,
      next_run_at: null,
      schedule_once_at: at,
    });
    const init = runtime.mock.calls.find(
      ([, request]) => new URL(request.url).pathname === "/internal/init"
    )!;
    const prompt = runtime.mock.calls.find(
      ([, request]) => new URL(request.url).pathname === "/internal/prompt"
    )!;
    expect(await init[1].json()).toMatchObject({
      title: "[Auto] Test Automation",
      repoOwner: null,
      repoName: null,
    });
    expect(await prompt[1].json()).toMatchObject({ content: "Run tests", source: "automation" });
    expect((await store.list({ limit: 10 })).automations.map((a) => a.id)).toContain("once");
    await scheduler.tick();
    expect(runtime).toHaveBeenCalledTimes(2);
    expect(await fetchRuns("once")).toHaveLength(1);

    await scheduler.runComplete({
      automationId: "once",
      runId: run.id,
      sessionId: run.session_id!,
      messageId: "msg-first",
      success: true,
    });
    expect((await store.list({ limit: 10 })).automations).toHaveLength(0);
    const history = await store.listInvocations("once", { limit: 10, offset: 0 });
    expect(history.total).toBe(1);
    expect(history.invocations[0]).toMatchObject({
      status: "completed",
      source: "schedule",
      scheduledAt: at,
      runs: [{ sessionId: run.session_id, status: "completed" }],
    });
    expect(await store.getById("once")).not.toBeNull();
    await store.update("once", { schedule_once_at: at });
    expect(await store.getById("once")).toMatchObject({ enabled: 0, next_run_at: null });
  });

  it("admits only one session when two ticks hold the same due snapshot", async () => {
    const at = Date.now() - 1;
    const store = await createOneShot("replay", at);
    const snapshot = (await store.getById("replay"))!;
    vi.spyOn(AutomationStore.prototype, "getOverdueAutomations").mockResolvedValue([snapshot]);
    const { scheduler, runtime } = createScheduler();
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    await scheduler.tick(); // Redelivery after the first session has launched.
    expect(
      runtime.mock.calls.filter(([, request]) => new URL(request.url).pathname === "/internal/init")
    ).toHaveLength(1);
    expect(await fetchRuns("replay")).toHaveLength(1);
    expect((await store.listInvocations("replay", { limit: 10, offset: 0 })).total).toBe(1);
    expect(await store.getById("replay")).toMatchObject({ enabled: 1, next_run_at: null });
    const [run] = await fetchRuns("replay");
    await scheduler.runComplete({
      automationId: "replay",
      runId: run.id,
      sessionId: run.session_id!,
      messageId: "msg-first",
      success: true,
    });
    await scheduler.tick(); // Replay after completion must also leave the original session alone.
    expect(runtime).toHaveBeenCalledTimes(2);
    expect(await fetchRuns("replay")).toHaveLength(1);
  });

  it("keeps an authorization-denied one-shot visible after a real denied tick", async () => {
    const store = await createOneShot("denied", Date.now() - 1);
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), OWNER)
      .run();
    const { scheduler, runtime } = createScheduler();
    expect(await scheduler.tick()).toEqual({ processed: 0, skipped: 1, failed: 0 });
    expect(runtime).not.toHaveBeenCalled();
    expect(await fetchRuns("denied")).toEqual([]);
    expect(await store.getById("denied")).toMatchObject({ enabled: 0, next_run_at: null });
    const history = await store.listInvocations("denied", { limit: 10, offset: 0 });
    expect(history.invocations).toEqual([
      expect.objectContaining({
        status: "skipped",
        skipReason: "execution_authorization_denied",
        runs: [],
      }),
    ]);
    expect((await store.list({ limit: 1 })).automations.map((a) => a.id)).toEqual(["denied"]);
  });

  it("rejects a stale resume after a concurrent reschedule and fires only at the new time", async () => {
    const firstAt = Date.now() + 60_000;
    const secondAt = firstAt + 60_000;
    const store = await createOneShot("rescheduled", firstAt);
    await store.pause("rescheduled");
    // Resume read T1; an edit commits T2 before the prepared resume is executed.
    const observed = (await store.getById("rescheduled"))!;
    const resume = store.bindResume(observed.id, observed.schedule_once_at!);
    await store.update("rescheduled", { schedule_once_at: secondAt, next_run_at: null });
    const result = await resume.run();
    expect(result.meta.changes).toBe(0);
    expect(await store.getById("rescheduled")).toMatchObject({
      enabled: 0,
      schedule_once_at: secondAt,
      next_run_at: null,
    });
    expect(await store.resume("rescheduled", secondAt)).toBe(true);
    const { scheduler, runtime } = createScheduler();
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstAt);
    await scheduler.tick();
    expect(runtime).not.toHaveBeenCalled();
    expect(await fetchRuns("rescheduled")).toEqual([]);
    clock.mockReturnValue(secondAt);
    expect(await scheduler.tick()).toMatchObject({ processed: 1, failed: 0 });
    expect(await fetchRuns("rescheduled")).toEqual([
      expect.objectContaining({ scheduled_at: secondAt, status: "running" }),
    ]);
  });

  it("uses the live enabled state when a concurrent resume commits before rescheduling", async () => {
    const firstAt = Date.now() + 60_000;
    const secondAt = firstAt + 60_000;
    const store = await createOneShot("resume-first", firstAt);
    await store.pause("resume-first");
    // The edit read a paused row, then resume commits before the edit writes.
    const edit = store.bindAutomationUpdate("resume-first", {
      schedule_once_at: secondAt,
      next_run_at: null,
    })!;
    expect(await store.resume("resume-first", firstAt)).toBe(true);
    await edit.run();
    expect(await store.getById("resume-first")).toMatchObject({
      enabled: 1,
      schedule_once_at: secondAt,
      next_run_at: secondAt,
    });
    const { scheduler, runtime } = createScheduler();
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstAt);
    await scheduler.tick();
    expect(runtime).not.toHaveBeenCalled();
    clock.mockReturnValue(secondAt);
    expect(await scheduler.tick()).toMatchObject({ processed: 1, failed: 0 });
  });

  it.each(["admission", "overlap", "denial"] as const)(
    "refuses a stale next_run_at at one-shot %s",
    async (path) => {
      const firstAt = Date.now() + 60_000;
      const secondAt = firstAt + 60_000;
      const store = await createOneShot("stale-slot", secondAt);
      // Reproduce a row left by the old reschedule/resume race.
      await store.update("stale-slot", { next_run_at: firstAt });
      if (path === "overlap")
        await seedRun(makeRunRow("stale-slot", { status: "running", started_at: Date.now() }));
      if (path === "denial")
        await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
          .bind(Date.now(), OWNER)
          .run();
      vi.spyOn(Date, "now").mockReturnValue(firstAt);
      const { scheduler, runtime } = createScheduler();
      await scheduler.tick();
      expect(runtime).not.toHaveBeenCalled();
      const history = await store.listInvocations("stale-slot", { limit: 10, offset: 0 });
      expect(history.invocations.filter((i) => i.source === "schedule")).toEqual([]);
      expect(await store.getById("stale-slot")).toMatchObject({
        enabled: 1,
        schedule_once_at: secondAt,
        next_run_at: firstAt,
      });
    }
  );

  it("disables a failed one-shot without retrying it and keeps it visible for inspection", async () => {
    const store = await createOneShot("failure", Date.now() - 1);
    const { scheduler, runtime } = createScheduler();
    runtime.mockResolvedValue(Response.json({ error: "Runtime unavailable" }, { status: 503 }));
    expect(await scheduler.tick()).toMatchObject({ processed: 0, failed: 1 });
    const [run] = await fetchRuns("failure");
    expect(run.status).toBe("failed");
    expect(await store.getById("failure")).toMatchObject({ enabled: 0, next_run_at: null });
    expect((await store.list({ limit: 10 })).automations.map((a) => a.id)).toContain("failure");
    await scheduler.tick();
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(await fetchRuns("failure")).toHaveLength(1);
  });

  it.each(["pause", "delete"] as const)(
    "does not launch after %s, including a tick holding a stale snapshot",
    async (action) => {
      const at = Date.now() + 60_000;
      const store = await createOneShot("cancel", at);
      const snapshot = (await store.getById("cancel"))!;
      if (action === "pause") await store.pause("cancel");
      else await store.softDelete("cancel");
      vi.spyOn(Date, "now").mockReturnValue(at);
      const { scheduler, runtime } = createScheduler();
      await scheduler.tick();
      vi.spyOn(AutomationStore.prototype, "getOverdueAutomations").mockResolvedValue([snapshot]);
      await scheduler.tick();
      expect(runtime).not.toHaveBeenCalled();
      expect(await fetchRuns("cancel")).toHaveLength(0);
      expect((await store.listInvocations("cancel", { limit: 10, offset: 0 })).total).toBe(0);
    }
  );

  it("records an overlap skip once and hides it only once the active run settles", async () => {
    const store = await createOneShot("skip", Date.now() - 1);
    const active = makeRunRow("skip", {
      status: "running",
      started_at: Date.now(),
      session_id: "manual-session",
    });
    await seedRun(active);
    const { scheduler, runtime } = createScheduler();
    expect(await scheduler.tick()).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    await scheduler.tick();
    expect(runtime).not.toHaveBeenCalled();
    expect(await store.getById("skip")).toMatchObject({ enabled: 0, next_run_at: null });
    const history = await store.listInvocations("skip", { limit: 10, offset: 0 });
    expect(history.invocations.filter((i) => i.source === "schedule")).toEqual([
      expect.objectContaining({ status: "skipped", skipReason: "concurrent_run_active", runs: [] }),
    ]);
    expect((await store.list({ limit: 10 })).automations).toHaveLength(1);
    await store.updateRun(active.id, { status: "completed", completed_at: Date.now() });
    expect((await store.list({ limit: 10 })).automations).toHaveLength(0);
  });

  it("records an overlap race as a skipped one-shot instead of losing the invocation", async () => {
    const at = Date.now() - 1;
    const store = await createOneShot("race", at);
    // The cheap pre-check misses a run that the atomic admission sees.
    await seedRun(makeRunRow("race", { status: "running", started_at: Date.now() }));
    vi.spyOn(AutomationStore.prototype, "getActiveRunForAutomation").mockResolvedValue(null);
    const { scheduler, runtime } = createScheduler();
    await scheduler.tick();
    expect(runtime).not.toHaveBeenCalled();
    expect(
      (await store.listInvocations("race", { limit: 10, offset: 0 })).invocations
    ).toContainEqual(
      expect.objectContaining({ source: "schedule", status: "skipped", scheduledAt: at })
    );
    expect(await store.getById("race")).toMatchObject({ enabled: 0, next_run_at: null });
  });

  it.each([
    ["completed", false],
    ["skipped", false],
    ["failed", true],
    ["starting", true],
    ["running", true],
    ["partial_failed", true],
    ["unauthorized", true],
    ["never", true],
  ] as const)(
    "keeps list visibility for %s correct before applying cursor pagination",
    async (status, visible) => {
      const at = Date.now() - 60_000;
      const store = await createOneShot("candidate", at, 20);
      await store.pause("candidate");
      if (status !== "never") {
        // Seed settled and active states through normal invocation storage.
        await store.resume("candidate", at);
        const invocation = makeInvocation("candidate", { source: "schedule", scheduled_at: at });
        if (status === "skipped") {
          await store.insertSkippedInvocation(
            { ...invocation, skip_reason: "concurrent_run_active" },
            { fromSlot: at, nextRunAt: null }
          );
        } else {
          const statuses: AutomationRunRow["status"][] =
            status === "partial_failed" ? ["completed", "failed"] : [status];
          await store.insertInvocationGuarded({
            invocation,
            children: statuses.map((s) => makeChild("candidate", { status: s })),
            overlapScope: { kind: "automation" },
            advanceSchedule: { fromSlot: at, nextRunAt: null },
          });
        }
      }
      await store.create(makeAutomation({ id: "older", created_at: 10 }));
      await store.create(makeAutomation({ id: "newer", created_at: 30 }));
      const ids: string[] = [];
      let page = await store.list({ limit: 1 });
      ids.push(...page.automations.map((a) => a.id));
      while (page.hasMore) {
        page = await store.list({ limit: 1, cursor: page.nextCursor });
        expect(page.automations).toHaveLength(1);
        ids.push(...page.automations.map((a) => a.id));
      }
      expect(ids).toEqual(visible ? ["newer", "candidate", "older"] : ["newer", "older"]);
      if (status !== "never")
        expect((await store.listInvocations("candidate", { limit: 10, offset: 0 })).total).toBe(1);
    }
  );

  it("does not hide a never-fired one-shot after a successful manual run", async () => {
    const store = await createOneShot("manual", Date.now() + 60_000);
    await seedRun(makeRunRow("manual", { status: "completed", completed_at: Date.now() }));
    await store.pause("manual");
    expect((await store.list({ limit: 10 })).automations.map((a) => a.id)).toContain("manual");
  });

  it("keeps recurring schedules enabled and advances them after firing", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(
      makeAutomation({
        id: "recurring",
        user_id: OWNER,
        created_by: OWNER,
        next_run_at: Date.now() - 1,
      })
    );
    const { scheduler } = createScheduler();
    expect(await scheduler.tick()).toMatchObject({ processed: 1, failed: 0 });
    expect(await store.getById("recurring")).toMatchObject({
      enabled: 1,
      schedule_once_at: null,
      next_run_at: expect.any(Number),
    });
    expect((await store.getById("recurring"))!.next_run_at).toBeGreaterThan(Date.now());
    expect((await store.list({ limit: 10 })).automations).toHaveLength(1);
  });
});
