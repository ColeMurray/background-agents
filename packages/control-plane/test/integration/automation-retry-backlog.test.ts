import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { AutomationStore } from "../../src/db/automation-store";
import { createScheduler } from "../../src/scheduler/factory";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";

describe("withdrawn launch retries with a backlog (D1 integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("can leave a paused retry waiting for more than a minute before marking it failed", async () => {
    const pausedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(pausedAt);
    const store = new AutomationStore(env.DB);

    // More than two retry-sweep batches, ordered by retry time.
    for (let index = 0; index < 51; index++) {
      const automation = makeAutomation({ id: `backlog-${index}`, max_retries: 2 });
      await store.create(automation);
      const invocation = makeInvocation(automation.id, {
        source: "schedule",
        scheduled_at: pausedAt,
      });
      const child = makeChild(automation.id, { id: `backlog-run-${index}` });
      expect(
        await store.insertInvocationGuarded({
          invocation,
          children: [child],
          overlapScope: { kind: "automation" },
        })
      ).toEqual({ inserted: true });
      expect(
        await store.failLaunchOrRetry(
          child.id,
          "fixture launch failure",
          pausedAt,
          pausedAt + 120_000 + index
        )
      ).toBe("retrying");
      await store.pause(automation.id);
    }

    const scheduler = createScheduler(env.DB, createCloudflareEnv(env), { submit() {} });
    for (const elapsedMs of [0, 60_000]) {
      clock.mockReturnValue(pausedAt + elapsedMs);
      await scheduler.tick();
      expect(await store.getRunById("backlog-50", "backlog-run-50")).toMatchObject({
        status: "retrying",
        attempt: 1,
        session_id: null,
        completed_at: null,
      });
    }

    clock.mockReturnValue(pausedAt + 120_000);
    await scheduler.tick();
    expect(await store.getRunById("backlog-50", "backlog-run-50")).toMatchObject({
      status: "failed",
      attempt: 1,
      session_id: null,
      completed_at: pausedAt + 120_000,
      retry_at: null,
    });
  }, 30_000);
});
