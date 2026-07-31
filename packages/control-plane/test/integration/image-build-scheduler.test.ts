import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../../src/index";
import { ImageBuildStore } from "../../src/db/image-builds";
import type { ImageBuildAdapterFactory } from "../../src/image-builds/provider-factory";
import { IMAGE_BUILD_SCHEDULER_CRON, ImageBuildScheduler } from "../../src/image-builds/scheduler";
import type { ImageBuildWorkflow } from "../../src/image-builds/workflow";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, getRow, seedEnvironment } from "./image-build-helpers";

describe("image build scheduler integration", () => {
  beforeEach(cleanD1Tables);

  it("routes the image-build cron to maintenance instead of the automation Durable Object", async () => {
    const schedulerNamespace = {
      idFromName: vi.fn(() => {
        throw new Error("automation scheduler should not run");
      }),
    };

    await worker.scheduled(
      { cron: IMAGE_BUILD_SCHEDULER_CRON } as ScheduledEvent,
      { DB: env.DB, SCHEDULER: schedulerNamespace } as unknown as Env,
      createExecutionContext()
    );

    expect(schedulerNamespace.idFromName).not.toHaveBeenCalled();
  });

  it("republishes an old accepted completion without stale-failing it in the same tick", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const callbackTime = Date.now() - 2 * 60 * 60 * 1000;
    const completionHash = "a".repeat(64);
    await store.registerBuild({
      id: "recover-before-stale",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: callbackTime + 60_000,
    });
    await store.bindProviderSession("recover-before-stale", "modal", "session-1");
    await store.finalization.acceptSuccessfulCompletion({
      buildId: "recover-before-stale",
      provider: "modal",
      providerSessionId: "session-1",
      tokenHash: "token-hash",
      completionHash,
      repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 1_000,
      now: callbackTime,
    });
    await env.DB.prepare("UPDATE image_builds SET created_at = 1 WHERE id = ?")
      .bind("recover-before-stale")
      .run();

    const send = vi.fn(async () => undefined);
    const workflow = {
      cleanupImages: vi.fn(async () => ({
        deletedFailed: 0,
        reapedFailed: 0,
        reapedSuperseded: 0,
      })),
    } as unknown as ImageBuildWorkflow;
    const scheduler = new ImageBuildScheduler(
      { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
      env.DB,
      null,
      store,
      workflow,
      { create: vi.fn() } as unknown as ImageBuildAdapterFactory,
      null
    );

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.finalizationsRepublished).toBe(1);
    expect(stats.staleMarked).toBe(0);
    expect(send).toHaveBeenCalledWith({
      version: 1,
      buildId: "recover-before-stale",
      completionHash,
    });
    expect(await getRow("recover-before-stale")).toMatchObject({
      status: "building",
      completion_hash: completionHash,
    });
  });
});
