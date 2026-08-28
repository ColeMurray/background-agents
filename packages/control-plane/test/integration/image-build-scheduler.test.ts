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

  it("routes the image-build cron to maintenance instead of the automation scheduler", async () => {
    await expect(
      worker.scheduled(
        { cron: IMAGE_BUILD_SCHEDULER_CRON } as ScheduledEvent,
        { DB: env.DB } as unknown as Env,
        createExecutionContext()
      )
    ).resolves.toBeUndefined();
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
      buildDurationSeconds: 1,
      now: callbackTime,
    });
    await env.DB.prepare("UPDATE image_builds SET created_at = 1 WHERE id = ?")
      .bind("recover-before-stale")
      .run();

    const send = vi.fn(async () => undefined);
    const workflow = {} as unknown as ImageBuildWorkflow;
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

  it("republishes every recoverable completion in one full scan", async () => {
    const store = new ImageBuildStore(env.DB);
    const completionHash = "b".repeat(64);
    for (let index = 0; index < 21; index += 1) {
      const environmentId = await seedEnvironment({ id: `env-recover-${index}` });
      const buildId = `recover-${index}`;
      await store.registerBuild({
        id: buildId,
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: `fingerprint-${index}`,
        callbackTokenHash: `token-hash-${index}`,
        callbackTokenExpiresAt: Date.now() + 60_000,
      });
      await store.bindProviderSession(buildId, "modal", `session-${index}`);
      await store.finalization.acceptSuccessfulCompletion({
        buildId,
        provider: "modal",
        providerSessionId: `session-${index}`,
        tokenHash: `token-hash-${index}`,
        completionHash,
        repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
        runtimeVersion: "v53-runtime",
        buildDurationSeconds: 1,
        now: index + 1,
      });
    }

    const send = vi.fn(async () => undefined);
    const workflow = {} as unknown as ImageBuildWorkflow;
    const scheduler = new ImageBuildScheduler(
      { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
      env.DB,
      null,
      store,
      workflow,
      { create: vi.fn() } as unknown as ImageBuildAdapterFactory,
      null
    );

    const stats = await scheduler.run({ request_id: "cron-full-scan", trace_id: "cron-full-scan" });

    expect(stats.finalizationsRepublished).toBe(21);
    expect(send).toHaveBeenCalledTimes(21);
  });

  it("cleans every pending provider session in one full scan", async () => {
    const store = new ImageBuildStore(env.DB);
    for (let index = 0; index < 21; index += 1) {
      const environmentId = await seedEnvironment({ id: `env-cleanup-${index}` });
      const buildId = `cleanup-${index}`;
      await store.registerBuild({
        id: buildId,
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: `fingerprint-${index}`,
      });
      await store.bindProviderSession(buildId, "modal", `session-cleanup-${index}`);
      await store.markBuildFailed(buildId, "modal", "failed");
    }

    const cleanupFailedBuild = vi.fn(async () => undefined);
    const workflow = {} as unknown as ImageBuildWorkflow;
    const scheduler = new ImageBuildScheduler(
      {} as Env,
      env.DB,
      null,
      store,
      workflow,
      {
        create: vi.fn(() => ({
          cleanupFailedBuild,
          cleanupCompletedBuild: vi.fn(async () => undefined),
        })),
      } as unknown as ImageBuildAdapterFactory,
      null
    );

    const stats = await scheduler.run({ request_id: "cron-full-scan", trace_id: "cron-full-scan" });

    expect(stats.cleanupAttempted).toBe(21);
    expect(stats.cleanupSucceeded).toBe(21);
    expect(cleanupFailedBuild).toHaveBeenCalledTimes(21);
  });
});
