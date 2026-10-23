import { AUTOMATION_RETRY_DELAY_MS } from "@open-inspect/shared/types/automations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore, type AutomationRunRow } from "../../src/db/automation-store";
import { claimRetry as claimPendingRetry, listDueRetries } from "../../src/db/automation-retries";
import { Scheduler } from "../../src/scheduler/scheduler";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";

const retryContext = JSON.stringify({
  instructions: "Original prompt with event context",
  platformUserId: "user-1",
  participantUserId: "user-1",
});

async function claimRetry(db: typeof env.DB, previousId: string, now: number) {
  const pending = await db
    .prepare("SELECT * FROM automation_runs WHERE retry_of_run_id = ?")
    .bind(previousId)
    .first<AutomationRunRow>();
  return pending ? claimPendingRetry(db, pending, now) : null;
}

describe("automation job retries (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });

  async function seed(
    maxRetries = 2,
    children = [
      makeChild("auto", {
        id: "first",
        status: "failed",
        failure_reason: "D1 unavailable",
        completed_at: Date.now(),
      }),
    ]
  ) {
    const store = new AutomationStore(env.DB);
    await store.create(makeAutomation({ id: "auto", max_retries: maxRetries }));
    await store.insertInvocationGuarded({
      invocation: makeInvocation("auto", { id: "inv", retry_context: retryContext }),
      children,
      overlapScope: { kind: "automation" },
    });
    return store;
  }

  it("persists the configured retry budget", async () => {
    const store = await seed();
    expect((await store.getById("auto"))?.max_retries).toBe(2);
  });

  it("waits beyond a database stall and reserves the firing while retrying", async () => {
    const store = await seed();
    const run = (await store.getRunById("auto", "first:retry"))!;
    expect(run.status).toBe("retrying");
    expect(run.retry_at).toBe(
      (await store.getRunById("auto", "first"))!.completed_at! + AUTOMATION_RETRY_DELAY_MS
    );
    expect(await listDueRetries(env.DB, run.retry_at! - 1, 25)).toEqual([]);
    expect(await listDueRetries(env.DB, run.retry_at!, 25)).toHaveLength(1);
    expect((await store.getInvocation("auto", "inv"))?.status).toBe("retrying");
    expect((await store.getInvocation("auto", "inv"))?.completedAt).toBeNull();
    expect((await store.getActiveRunForAutomation("auto"))?.id).toBe("first:retry");
    expect(
      await store.insertInvocationGuarded({
        invocation: makeInvocation("auto", { id: "duplicate" }),
        children: [makeChild("auto")],
        overlapScope: { kind: "automation" },
      })
    ).toEqual({ inserted: false });
  });

  it.each(["repository", "environment", "no target"])(
    "admits one retry under racing ticks for %s and keeps the target snapshot",
    async (target) => {
      const first = makeChild("auto", {
        id: "first",
        status: "failed",
        completed_at: Date.now(),
        ...(target === "repository"
          ? { repo_owner: "group/subgroup", repo_name: "app", repo_id: 1, base_branch: "release" }
          : {}),
        ...(target === "environment" ? { environment_id: "env_original" } : {}),
      });
      const store = await seed(2, [first]);
      const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
      const claimed = await Promise.all([
        claimRetry(env.DB, "first", due),
        claimRetry(env.DB, "first", due),
      ]);
      const winners = claimed.filter((run) => run !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({
        attempt: 2,
        created_at: due,
        status: "starting",
        invocation_id: "inv",
        repo_owner: first.repo_owner,
        repo_name: first.repo_name,
        base_branch: first.base_branch,
        environment_id: first.environment_id,
        scheduled_at: first.scheduled_at,
      });
      expect(
        (
          await env.DB.prepare(AutomationStore.ORPHANED_STARTING_RUNS_SQL)
            .bind(due - 1)
            .all()
        ).results
      ).toEqual([]);
      const history = (await store.getInvocation("auto", "inv"))!;
      expect(history.runs).toHaveLength(2);
      expect(history.runs.find((run) => run.id === "first")).toMatchObject({
        status: "failed",
        supersededAt: first.completed_at,
      });
      expect((await store.getInvocationRunAggregate("inv")).total).toBe(1);
    }
  );

  it("backs off, exhausts its budget, and preserves the last failure", async () => {
    const store = await seed(1);
    const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
    const retry = (await claimRetry(env.DB, "first", due))!;
    await store.updateRun(retry.id, {
      status: "failed",
      completed_at: due + 1,
      failure_reason: "Final failure",
      retryable: 1,
    });
    expect(await listDueRetries(env.DB, due + 10 * AUTOMATION_RETRY_DELAY_MS, 25)).toEqual([]);
    expect((await store.getInvocation("auto", "inv"))?.status).toBe("failed");
    expect((await store.getRunById("auto", "first:retry"))?.failure_reason).toBe("Final failure");
    expect(await store.getInvocationRunAggregate("inv")).toMatchObject({ total: 1, failed: 1 });
  });

  it("doubles the delay after each failed retry", async () => {
    const store = await seed(2);
    const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
    await claimRetry(env.DB, "first", due);
    await store.updateRun("first:retry", {
      status: "failed",
      completed_at: due + 10,
      retryable: 1,
    });
    expect((await store.getRunById("auto", "first:retry:retry"))?.retry_at).toBe(
      due + 10 + 2 * AUTOMATION_RETRY_DELAY_MS
    );
  });

  it("keeps successful siblings and excludes superseded failures from all summaries", async () => {
    const store = await seed(1, [
      makeChild("auto", {
        id: "first",
        status: "failed",
        completed_at: Date.now(),
        repo_owner: "acme",
        repo_name: "a",
      }),
      makeChild("auto", {
        id: "success",
        status: "completed",
        completed_at: Date.now(),
        repo_owner: "acme",
        repo_name: "b",
      }),
    ]);
    const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
    await claimRetry(env.DB, "first", due);
    await store.updateRun("first:retry", { status: "completed", completed_at: due + 1 });
    expect((await store.getInvocation("auto", "inv"))?.status).toBe("completed");
    expect(
      (await store.listInvocations("auto", { limit: 10, offset: 0 })).invocations[0]?.status
    ).toBe("completed");
    expect(
      (await store.listRecentExecutionsForAutomationIds(["auto"], 5)).get("auto")?.[0]?.status
    ).toBe("completed");
    expect(await store.getInvocationRunAggregate("inv")).toMatchObject({
      total: 2,
      completed: 2,
      failed: 0,
    });
    expect((await store.getRunById("auto", "success"))?.attempt).toBe(1);
  });

  it.each(["Execution was cancelled", "Execution was canceled before it started"])(
    "does not retry explicit cancellation: %s",
    async (reason) => {
      const store = await seed(2, [
        makeChild("auto", { id: "first", status: "running", session_id: "old-session" }),
      ]);
      const scheduler = new Scheduler(env.DB, createCloudflareEnv(env), { submit() {} });
      await scheduler.runComplete({
        automationId: "auto",
        runId: "first",
        sessionId: "old-session",
        messageId: "first-message",
        success: false,
        error: reason,
        cancelled: true,
      });
      expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
      expect(await listDueRetries(env.DB, Date.now() + AUTOMATION_RETRY_DELAY_MS, 25)).toEqual([]);
    }
  );

  it("honors cancellation of the previous session during backoff", async () => {
    const store = await seed(2, [
      makeChild("auto", { id: "first", status: "running", session_id: "old-session" }),
    ]);
    await env.DB.prepare(
      "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('old-session', 'active', 1, 1)"
    ).run();
    await store.updateRun("first", { status: "failed", completed_at: Date.now(), retryable: 1 });
    await env.DB.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = 'old-session'").run();
    const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
    expect(await claimRetry(env.DB, "first", due)).toBeNull();
    expect(await listDueRetries(env.DB, due, 25)).toEqual([]);
    expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
  });

  it("counts one final failure only after retries are exhausted", async () => {
    const store = await seed(1, [
      makeChild("auto", { id: "first", status: "running", session_id: "old-session" }),
    ]);
    await store.update("auto", { consecutive_failures: 2 });
    const scheduler = new Scheduler(env.DB, createCloudflareEnv(env), { submit() {} });
    await scheduler.runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "old-session",
      messageId: "one",
      success: false,
    });
    const due = (await store.getRunById("auto", "first:retry"))!.retry_at!;
    await claimRetry(env.DB, "first", due);
    await store.claimRunSession("first:retry", "new-session", due, due + 60_000);
    for (let i = 0; i < 2; i++) {
      await scheduler.runComplete({
        automationId: "auto",
        runId: "first:retry",
        sessionId: "new-session",
        messageId: "two",
        success: false,
        error: "Last failure",
      });
    }
    expect(await store.getById("auto")).toMatchObject({ consecutive_failures: 3, enabled: 0 });
    expect(await store.getInvocation("auto", "inv")).toMatchObject({ status: "failed" });
    expect((await store.getRunById("auto", "first:retry"))?.failure_reason).toBe("Last failure");
  });

  it("leaves ambiguous execution timeouts failed to avoid concurrent executions", async () => {
    const store = await seed(2, [
      makeChild("auto", {
        id: "first",
        status: "failed",
        failure_reason: "execution_timeout",
        completed_at: Date.now(),
        session_id: "possibly-running",
      }),
    ]);
    expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
  });

  it.each(["pause", "delete", "disable retries"])(
    "withdraws pending retries on %s",
    async (change) => {
      const store = await seed();
      if (change === "pause") await store.pause("auto");
      if (change === "delete") await store.softDelete("auto");
      if (change === "disable retries") await store.update("auto", { max_retries: 0 });
      expect(await claimRetry(env.DB, "first", Date.now() + AUTOMATION_RETRY_DELAY_MS)).toBeNull();
      expect(await listDueRetries(env.DB, Date.now() + AUTOMATION_RETRY_DELAY_MS, 25)).toEqual([]);
      expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
    }
  );

  it("launches exactly one retry through concurrent scheduler ticks and resets failures on success", async () => {
    const store = await seed(1, [
      makeChild("auto", {
        id: "first",
        status: "running",
        session_id: "old-session",
        execution_deadline_at: Date.now() + 60_000,
      }),
    ]);
    await store.update("auto", { consecutive_failures: 2 });
    const sessionFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/internal/init") return Response.json({ status: "ok" });
      if (path === "/internal/prompt")
        return Response.json({ messageId: "retry-message", status: "queued" });
      return new Response("Not found", { status: 404 });
    });
    const schedulerEnv = createCloudflareEnv({
      ...env,
      SESSION: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: sessionFetch })),
      } as unknown as DurableObjectNamespace,
    });
    const scheduler = () => new Scheduler(env.DB, schedulerEnv, { submit() {} });
    await scheduler().runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "old-session",
      messageId: "first-message",
      success: false,
      error: "Transient failure",
    });
    expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
    expect((await store.getRunById("auto", "first:retry"))?.status).toBe("retrying");
    expect((await store.getById("auto"))?.consecutive_failures).toBe(2);
    expect((await store.getById("auto"))?.enabled).toBe(1);
    // Advance the persisted deadline rather than sleeping or faking D1's clock.
    await env.DB.prepare("UPDATE automation_runs SET retry_at = ? WHERE status = 'retrying'")
      .bind(Date.now() - 1)
      .run();
    await Promise.all([scheduler().tick(), scheduler().tick()]);
    const invocation = (await store.getInvocation("auto", "inv"))!;
    expect(invocation.runs).toHaveLength(2);
    const retry = invocation.runs.find((run) => run.attempt === 2)!;
    expect(retry.status).toBe("running");
    expect(retry.failureReason).toBeNull();
    const prompts = sessionFetch.mock.calls.filter(
      ([request]) => new URL(request.url).pathname === "/internal/prompt"
    );
    expect(prompts).toHaveLength(1);
    expect(await prompts[0]![0].clone().json()).toMatchObject({
      content: "Original prompt with event context",
    });
    await scheduler().runComplete({
      automationId: "auto",
      runId: retry.id,
      sessionId: retry.sessionId!,
      messageId: "retry-message",
      success: true,
    });
    expect((await store.getInvocation("auto", "inv"))?.status).toBe("completed");
    expect((await store.getById("auto"))?.consecutive_failures).toBe(0);
    // A stale callback cannot overwrite the successful retry or resurrect its ancestor.
    await scheduler().runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "old-session",
      messageId: "first-message",
      success: false,
      error: "Late duplicate",
    });
    expect((await store.getInvocation("auto", "inv"))?.status).toBe("completed");
  });

  it("returns an accepted manual firing when launch fails but a retry is pending", async () => {
    const store = await seed(1, []);
    const schedulerEnv = createCloudflareEnv({
      ...env,
      SESSION: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: async () => new Response("Transient launch failure", { status: 503 }),
        })),
      } as unknown as DurableObjectNamespace,
    });
    const scheduler = new Scheduler(env.DB, schedulerEnv, { submit() {} });
    const result = await scheduler.trigger("auto", "user-1");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      status: "retrying",
      attempt: 2,
      retryAt: expect.any(Number),
    });
    expect((await store.getById("auto"))?.consecutive_failures).toBe(0);
  });

  it("rechecks the original execution user's authorization before launching a retry", async () => {
    const store = await seed();
    await env.DB.prepare("UPDATE automation_runs SET retry_at = ? WHERE status = 'retrying'")
      .bind(Date.now() - 1)
      .run();
    await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = 'user-1'").run();
    const sessionFetch = vi.fn(async () => Response.json({ status: "ok" }));
    const schedulerEnv = createCloudflareEnv({
      ...env,
      SESSION: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: sessionFetch })),
      } as unknown as DurableObjectNamespace,
    });
    await new Scheduler(env.DB, schedulerEnv, { submit() {} }).tick();
    const invocation = (await store.getInvocation("auto", "inv"))!;
    expect(invocation.runs).toHaveLength(2);
    expect(invocation.runs.find((run) => run.attempt === 2)?.status).toBe("unauthorized");
    expect(sessionFetch).not.toHaveBeenCalled();
    expect((await store.getById("auto"))?.consecutive_failures).toBe(0);
  });

  it("defaults existing jobs to no retries", async () => {
    const store = await seed(0);
    expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
  });
});
