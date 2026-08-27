import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../../src/index";
import { SessionIndexStore } from "../../src/db/session-index";
import { ABANDONED_DRAFT_SWEEP_CRON } from "../../src/session/abandoned-draft-sweep";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";

const HOUR_MS = 60 * 60 * 1000;

async function seedStaleDraft(id: string): Promise<void> {
  await new SessionIndexStore(env.DB).create({
    id,
    title: id,
    repoOwner: "acme",
    repoName: "web-app",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    createdAt: Date.now() - 48 * HOUR_MS,
    updatedAt: Date.now() - 48 * HOUR_MS,
  });
}

function createSessionNamespace(response: () => Response) {
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch: vi.fn(async () => response()) })),
  };
}

describe("abandoned draft sweep cron routing", () => {
  beforeEach(cleanD1Tables);

  it("routes the draft-sweep cron to the sweep instead of the automation scheduler", async () => {
    await seedStaleDraft("stale-draft");
    const sessionNamespace = createSessionNamespace(() =>
      Response.json({ outcome: "archived", status: "archived" })
    );

    await worker.scheduled(
      { cron: ABANDONED_DRAFT_SWEEP_CRON } as ScheduledEvent,
      {
        DB: env.DB,
        SESSION: sessionNamespace,
      } as unknown as Env,
      createExecutionContext()
    );

    // Proves the sweep actually ran rather than falling through to the
    // unknown-trigger branch, which would leave the session untouched.
    expect(sessionNamespace.idFromName).toHaveBeenCalledWith("stale-draft");
  });

  it("leaves the draft sweep alone on the automation tick", async () => {
    await seedStaleDraft("stale-draft");
    const sessionNamespace = createSessionNamespace(() =>
      Response.json({ outcome: "archived", status: "archived" })
    );

    await worker.scheduled(
      { cron: "* * * * *" } as ScheduledEvent,
      {
        DB: env.DB,
        SESSION: sessionNamespace,
      } as unknown as Env,
      createExecutionContext()
    );

    expect(sessionNamespace.idFromName).not.toHaveBeenCalled();
  });
});
