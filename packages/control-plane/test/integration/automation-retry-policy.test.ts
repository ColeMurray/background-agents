import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore } from "../../src/db/automation-store";
import { listDueRetries } from "../../src/db/automation-retries";
import { Scheduler } from "../../src/scheduler/scheduler";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import * as repositories from "../../src/automation/repository";
import * as harnessAdmission from "../../src/harness-admission";
import { ownershipRequest } from "./ownership-test-helpers";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";

const context = JSON.stringify({
  instructions: "Job",
  platformUserId: "user-1",
  participantUserId: "user-1",
});

async function seed(status: "failed" | "running" = "failed", maxRetries = 2) {
  const store = new AutomationStore(env.DB);
  await store.create(makeAutomation({ id: "auto", max_retries: maxRetries }));
  await store.insertInvocationGuarded({
    invocation: makeInvocation("auto", { id: "inv", retry_context: context }),
    children: [
      makeChild("auto", {
        id: "first",
        status,
        completed_at: status === "failed" ? Date.now() : null,
        session_id: status === "running" ? "original-session" : null,
      }),
    ],
    overlapScope: { kind: "automation" },
  });
  return store;
}

function runtime() {
  const sessionFetch = vi.fn(async (request: Request) =>
    Response.json(
      new URL(request.url).pathname === "/internal/init"
        ? { status: "ok" }
        : { status: "queued", messageId: "prompt" }
    )
  );
  return createCloudflareEnv({
    ...env,
    SESSION: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: sessionFetch })),
    } as unknown as DurableObjectNamespace,
  });
}

async function compete(store: AutomationStore) {
  return store.insertInvocationGuarded({
    invocation: makeInvocation("auto", { id: "competitor" }),
    children: [makeChild("auto")],
    overlapScope: { kind: "automation" },
  });
}

describe("automation retry policy and failure isolation (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["lookup", "context", "accounting", "publication", "discovery"])(
    "still admits unrelated overdue work after a retry %s failure",
    async (stage) => {
      const store = await seed("failed", 1);
      const overdueAt = Date.now() - 60_000;
      await store.create(makeAutomation({ id: "sched", next_run_at: overdueAt }));
      await env.DB.prepare(
        "UPDATE automation_runs SET retry_at = 0 WHERE status = 'retrying'"
      ).run();
      if (stage === "lookup")
        vi.spyOn(AutomationStore.prototype, "getInvocationById").mockRejectedValueOnce(
          new Error("D1_ERROR: transient")
        );
      if (stage === "context")
        await env.DB.prepare(
          "UPDATE automation_invocations SET retry_context = 'invalid-json' WHERE id = 'inv'"
        ).run();
      if (stage === "accounting")
        vi.spyOn(AutomationStore.prototype, "getInvocationRunAggregate").mockRejectedValueOnce(
          new Error("D1_ERROR: transient")
        );
      if (stage === "publication") {
        vi.spyOn(harnessAdmission, "validateHarnessExecution").mockRejectedValueOnce(
          new Error("Provider unavailable")
        );
        vi.spyOn(
          AutomationStore.prototype,
          "claimRetryCompletionPublication"
        ).mockRejectedValueOnce(new Error("D1_ERROR: transient"));
      }
      if (stage === "discovery") {
        const prepare = env.DB.prepare.bind(env.DB);
        vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
          if (sql.includes("retry_withdrawn_at = ?")) throw new Error("D1_ERROR: transient");
          return prepare(sql);
        });
      }
      await expect(new Scheduler(env.DB, runtime(), { submit() {} }).tick()).resolves.toBeDefined();
      expect((await store.listInvocations("sched", { limit: 10, offset: 0 })).total).toBe(1);
      expect((await store.getById("sched"))!.next_run_at).toBeGreaterThan(overdueAt);
    }
  );

  it("charges claimed retries to the tick budget even when accounting fails", async () => {
    const store = await seed("failed", 1);
    for (let index = 1; index < 25; index++) {
      const id = `retry-${index}`;
      await store.create(makeAutomation({ id, max_retries: 1 }));
      await store.insertInvocationGuarded({
        invocation: makeInvocation(id, { retry_context: context }),
        children: [makeChild(id, { status: "failed", completed_at: Date.now() })],
        overlapScope: { kind: "automation" },
      });
    }
    for (let index = 0; index < 3; index++) {
      const id = `scheduled-${index}`;
      await store.create(makeAutomation({ id, next_run_at: Date.now() - 60_000 + index }));
      await store.replaceRepositories(
        id,
        Array.from({ length: 10 }, (_, repo) => ({
          repo_owner: "acme",
          repo_name: `app-${repo}`,
          repo_id: repo + 1,
          base_branch: "main",
        }))
      );
    }
    vi.spyOn(repositories, "resolveAutomationRepositories").mockImplementation(
      async (_env, selection) =>
        selection.map((requested) => ({
          requested,
          error: null,
          repository: {
            repoOwner: requested.repo_owner,
            repoName: requested.repo_name,
            repoId: requested.repo_id!,
            baseBranch: "main",
          },
        }))
    );
    vi.spyOn(AutomationStore.prototype, "getInvocationRunAggregate").mockRejectedValue(
      new Error("D1_ERROR: accounting unavailable")
    );
    await env.DB.prepare("UPDATE automation_runs SET retry_at = 0 WHERE status = 'retrying'").run();
    await new Scheduler(env.DB, runtime(), { submit() {} }).tick();
    // Twenty-five retry attempts plus two ten-target firings fit; the third would exceed the budget.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM automation_runs WHERE status = 'running'"
      ).first()
    ).toEqual({ count: 45 });
    expect((await store.listInvocations("scheduled-2", { limit: 10, offset: 0 })).total).toBe(0);
  });

  it("distinguishes pending retries from running attempts while deferring failure accounting", async () => {
    const store = await seed("running");
    expect(await store.getInvocationRunAggregate("inv")).toMatchObject({
      active: 1,
      retrying: 0,
      failureCountingDeferred: true,
    });
    expect((await store.getInvocation("auto", "inv"))!.status).toBe("running");
  });

  it.each([
    "Sandbox could not cancel stale git lock; aborting",
    "SCM cancelled its background cleanup",
  ])("retries failure text without treating it as explicit cancellation: %s", async (error) => {
    const store = await seed("running");
    await new Scheduler(env.DB, runtime(), { submit() {} }).runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "original-session",
      messageId: "message",
      success: false,
      error,
    });
    expect(await store.getReservedRetry("first")).toMatchObject({ status: "retrying" });
  });

  it("uses structured cancellation independently of error wording", async () => {
    const store = await seed("running");
    await new Scheduler(env.DB, runtime(), { submit() {} }).runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "original-session",
      messageId: "message",
      success: false,
      error: "User withdrew this execution",
      cancelled: true,
    });
    expect(await store.getReservedRetry("first")).toBeNull();
  });

  it.each(["store", "route"])(
    "withdraws over-budget attempts immediately via the %s",
    async (via) => {
      const store = await seed("failed", 3);
      await env.DB.prepare(
        "UPDATE automation_runs SET attempt = 3 WHERE status = 'retrying'"
      ).run();
      if (via === "store") await store.update("auto", { max_retries: 1 });
      else {
        const response = await ownershipRequest("/automations/auto", {
          method: "PUT",
          body: JSON.stringify({ maxRetries: 1 }),
        });
        expect(response.status).toBe(200);
      }
      expect(await compete(store)).toEqual({ inserted: true });
      await store.update("auto", { max_retries: 3 });
      expect((await store.getReservedRetry("first"))!.status).toBe("failed");
    }
  );

  it("keeps an attempt that remains within a reduced retry budget", async () => {
    const store = await seed("failed", 3);
    await store.update("auto", { max_retries: 1 });
    expect((await store.getReservedRetry("first"))!.status).toBe("retrying");
    expect(await compete(store)).toEqual({ inserted: false });
  });

  it("does not reserve a retry for an already cancelled session", async () => {
    const store = await seed("running");
    await env.DB.prepare(
      "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('original-session', 'cancelled', 1, 1)"
    ).run();
    await new Scheduler(env.DB, runtime(), { submit() {} }).runComplete({
      automationId: "auto",
      runId: "first",
      sessionId: "original-session",
      messageId: "message",
      success: false,
      error: "SCM unavailable",
    });
    expect(await store.getReservedRetry("first")).toBeNull();
  });

  it("listing due attempts does not withdraw or otherwise mutate them", async () => {
    const store = await seed();
    await env.DB.prepare("UPDATE automations SET max_retries = 0 WHERE id = 'auto'").run();
    expect(await listDueRetries(env.DB, Date.now() + 120_000, 25)).toEqual([]);
    expect((await store.getReservedRetry("first"))!.status).toBe("retrying");
  });

  it("skips Slack publication when no attempt has a real session scope", async () => {
    const store = await seed("failed", 1);
    await env.DB.prepare("UPDATE automation_invocations SET trigger_metadata = ? WHERE id = 'inv'")
      .bind(JSON.stringify({ channel: "C1", messageTs: "100.1" }))
      .run();
    await env.DB.prepare("UPDATE automation_runs SET retry_at = 0 WHERE status = 'retrying'").run();
    vi.spyOn(harnessAdmission, "validateHarnessExecution").mockRejectedValueOnce(
      new Error("Provider unavailable")
    );
    const slackFetch = vi.fn(async () => new Response("ok"));
    await new Scheduler(
      env.DB,
      { ...runtime(), SLACK_BOT: { fetch: slackFetch }, SERVICE_AUTH_SECRET_SLACK_BOT: "secret" },
      { submit() {} }
    ).tick();
    expect((await store.getInvocation("auto", "inv"))!.status).toBe("failed");
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("does not store retry prompts for disabled retries", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(makeAutomation({ id: "auto", max_retries: 0 }));
    const result = await new Scheduler(env.DB, runtime(), { submit() {} }).trigger(
      "auto",
      "user-1"
    );
    expect((await store.getInvocationById(result.invocationId))!.retry_context).toBeNull();
  });
});
