import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { SqlDatabase } from "../db/sql-database";
import type { SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildScheduler } from "./scheduler";
import type { ImageBuildWorkflow } from "./workflow";

function harness(
  options: {
    provider?: "modal" | null;
    sourceControl?: SourceControlProvider | null;
    env?: Env;
  } = {}
) {
  const getSchedulerCursor = vi.fn(async () => null);
  const setSchedulerCursor = vi.fn(async () => undefined);
  const listProviderSessionCleanupPage = vi.fn(async () => [
    {
      id: "failed-cleanup",
      provider: "modal",
      status: "failed",
      provider_image_id: null,
      provider_session_id: "session-1",
      created_at: 1,
    },
    {
      id: "ready-cleanup",
      provider: "modal",
      status: "ready",
      provider_image_id: "image-1",
      provider_session_id: "session-2",
      created_at: 2,
    },
  ]);
  const clearProviderSessionCleanup = vi.fn(async () => true);
  const listEnabledScopeRefsPage = vi.fn(async () => ({
    scopes: [{ kind: "repo" as const, id: "acme/web" }],
    nextCursor: null,
  }));
  const listRecoverableFinalizations = vi.fn(
    async (): Promise<Array<{ id: string; completion_hash: string }>> => []
  );
  const store = {
    markStaleBuildsAsFailed: vi.fn(async () => 1),
    getSchedulerCursor,
    setSchedulerCursor,
    listProviderSessionCleanupPage,
    clearProviderSessionCleanup,
    listEnabledScopeRefsPage,
    maintenance: {
      getCursor: getSchedulerCursor,
      setCursor: setSchedulerCursor,
      listSessionCleanupPage: listProviderSessionCleanupPage,
      listEnabledScopeRefsPage,
      listRecoverableFinalizations,
    },
    finalization: {
      clearSessionCleanup: clearProviderSessionCleanup,
    },
    getReconciliationStatus: vi.fn(async () => []),
  };
  const adapter = {
    startBuild: vi.fn(),
    deleteImage: vi.fn(),
    cleanupFailedBuild: vi.fn(async () => {
      throw new Error("temporary cleanup failure");
    }),
    cleanupCompletedBuild: vi.fn(async () => undefined),
  };
  const workflow = {
    triggerBuild: vi.fn(async () => ({ type: "triggered" as const, buildId: "build-new" })),
    cleanupImages: vi.fn(async () => ({
      deletedFailed: 2,
      reapedFailed: 1,
      reapedSuperseded: 1,
    })),
  };
  const resolveTarget = vi.fn(async () => ({
    kind: "repo" as const,
    repoId: 1,
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    repositoriesFingerprint: "fp-current",
  }));
  const scheduler = new ImageBuildScheduler(
    options.env ?? ({} as Env),
    {} as SqlDatabase,
    options.provider === undefined ? "modal" : options.provider,
    store as unknown as ImageBuildStore,
    workflow as unknown as ImageBuildWorkflow,
    { create: vi.fn(() => adapter) } as unknown as ImageBuildAdapterFactory,
    options.sourceControl === undefined ? ({} as SourceControlProvider) : options.sourceControl,
    resolveTarget
  );
  return { scheduler, store, adapter, workflow, listRecoverableFinalizations };
}

describe("ImageBuildScheduler", () => {
  it("contains cleanup failures, advances fairness, and still dispatches rebuilds", async () => {
    const { scheduler, store, adapter, workflow } = harness();

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats).toMatchObject({
      staleMarked: 1,
      cleanupAttempted: 2,
      cleanupSucceeded: 1,
      cleanupFailed: 1,
      scopesScanned: 1,
      triggered: 1,
      rowsAged: 2,
      artifactsReaped: 2,
    });
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledOnce();
    expect(store.clearProviderSessionCleanup).toHaveBeenCalledTimes(1);
    expect(store.setSchedulerCursor).toHaveBeenCalledWith("session-cleanup", {
      scopeKind: null,
      scopeId: null,
      createdAt: null,
      rowId: null,
    });
    expect(store.setSchedulerCursor.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.cleanupFailedBuild.mock.invocationCallOrder[0]
    );
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(workflow.triggerBuild).toHaveBeenCalledWith(
      { kind: "repo", id: "acme/web" },
      expect.any(Object)
    );
    expect(store.getReconciliationStatus).toHaveBeenCalledWith(
      { kind: "repo", id: "acme/web" },
      "modal"
    );
  });

  it("continues reconciliation and artifact cleanup when a cleanup phase query fails", async () => {
    const { scheduler, store, workflow } = harness();
    store.getSchedulerCursor.mockRejectedValueOnce(new Error("D1 cleanup cursor unavailable"));

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(1);
    expect(stats.triggered).toBe(1);
    expect(workflow.cleanupImages).toHaveBeenCalledOnce();
  });

  it("runs provider-neutral maintenance when rebuild reconciliation is unavailable", async () => {
    const { scheduler, store, workflow } = harness({
      provider: null,
      sourceControl: null,
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.staleMarked).toBe(1);
    expect(stats.cleanupAttempted).toBe(2);
    expect(stats.scopesScanned).toBe(0);
    expect(store.listEnabledScopeRefsPage).not.toHaveBeenCalled();
    expect(workflow.cleanupImages).toHaveBeenCalledOnce();
  });

  it("republishes persisted artifacts left behind by exhausted Queue delivery", async () => {
    const send = vi.fn(async () => undefined);
    const { scheduler, listRecoverableFinalizations } = harness({
      env: { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
    });
    listRecoverableFinalizations.mockResolvedValue([
      { id: "build-recover", completion_hash: "a".repeat(64) },
    ]);

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.finalizationsRepublished).toBe(1);
    expect(send).toHaveBeenCalledWith({
      version: 1,
      buildId: "build-recover",
      completionHash: "a".repeat(64),
    });
  });
});
