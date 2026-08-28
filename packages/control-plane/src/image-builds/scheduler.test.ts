import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { SqlDatabase } from "../db/sql-database";
import type { SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import type { ImageBuildScope } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildScheduler } from "./scheduler";
import type { ResolvedImageBuildTarget } from "./scope";
import { COMPATIBLE_RUNTIME_VERSION } from "./test-helpers";
import type { ImageBuildWorkflow } from "./workflow";

function harness(
  options: {
    provider?: "modal" | null;
    sourceControl?: SourceControlProvider | null;
    env?: Env;
  } = {}
) {
  const listSessionCleanup = vi.fn(async () => [
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
  const listScopes = vi.fn(
    async (): Promise<ImageBuildScope[]> => [{ kind: "repo", id: "acme/web" }]
  );
  const listRecoverableFinalizations = vi.fn(
    async (): Promise<
      Array<{ id: string; completion_hash: string; callback_token_used_at: number }>
    > => []
  );
  const getReconciliationStatus = vi.fn(
    async (
      _scope: ImageBuildScope,
      _provider: "modal"
    ): Promise<Awaited<ReturnType<ImageBuildStore["getReconciliationStatus"]>>> => []
  );
  const store = {
    markStaleBuildsAsFailed: vi.fn(async () => 1),
    listSessionCleanup,
    clearProviderSessionCleanup,
    listRecoverableFinalizations,
    // The scheduler constructs its reaper internally, so the cleanup phase
    // runs real reap logic over these rows: one failed and one superseded
    // artifact delete → artifactsReaped 2, two aged rows → rowsAged 2.
    getFailedImagesWithArtifacts: vi.fn(async () => [
      {
        id: "reap-failed",
        scope_kind: "environment" as const,
        scope_id: "env_1",
        provider: "modal" as const,
        provider_image_id: "im-failed",
        provider_session_id: null,
        created_at: 1,
      },
    ]),
    clearFailedImageArtifact: vi.fn(async () => true),
    deleteOldFailedBuilds: vi.fn(async () => 2),
    getSupersededImages: vi.fn(async () => [
      {
        id: "reap-superseded",
        scope_kind: "environment" as const,
        scope_id: "env_1",
        provider: "modal" as const,
        provider_image_id: "im-superseded",
        provider_session_id: null,
        created_at: 2,
      },
    ]),
    deleteSupersededImage: vi.fn(async () => true),
    finalization: {
      clearSessionCleanup: clearProviderSessionCleanup,
    },
    getReconciliationStatus,
  };
  const adapter = {
    startBuild: vi.fn(),
    deleteImage: vi.fn(),
    cleanupFailedBuild: vi.fn(async (): Promise<void> => {
      throw new Error("temporary cleanup failure");
    }),
    cleanupCompletedBuild: vi.fn(async () => undefined),
  };
  const workflow = {
    triggerBuildWithTarget: vi.fn(async (_scope: ImageBuildScope) => ({
      type: "triggered" as const,
      buildId: "build-new",
    })),
  };
  const resolveTarget = vi.fn(
    async (
      _env: Env,
      _db: SqlDatabase,
      _scope: ImageBuildScope
    ): Promise<ResolvedImageBuildTarget> => ({
      kind: "repo",
      repoId: 1,
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-current",
    })
  );
  const scheduler = new ImageBuildScheduler(
    options.env ?? ({} as Env),
    {} as SqlDatabase,
    options.provider === undefined ? "modal" : options.provider,
    store as unknown as ImageBuildStore,
    workflow as unknown as ImageBuildWorkflow,
    { create: vi.fn(() => adapter) } as unknown as ImageBuildAdapterFactory,
    options.sourceControl === undefined ? ({} as SourceControlProvider) : options.sourceControl,
    resolveTarget,
    listScopes
  );
  return {
    scheduler,
    store,
    adapter,
    workflow,
    resolveTarget,
    listScopes,
    listSessionCleanup,
    listRecoverableFinalizations,
  };
}

describe("ImageBuildScheduler", () => {
  it("contains cleanup failures and still dispatches rebuilds", async () => {
    const { scheduler, store, adapter, workflow, resolveTarget } = harness();

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
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(workflow.triggerBuildWithTarget).toHaveBeenCalledWith(
      { kind: "repo", id: "acme/web" },
      expect.objectContaining({ repositoriesFingerprint: "fp-current" }),
      expect.any(Object)
    );
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(store.getReconciliationStatus).toHaveBeenCalledWith(
      { kind: "repo", id: "acme/web" },
      "modal"
    );
  });

  it("bounds provider-session cleanup concurrency while attempting every row", async () => {
    const { scheduler, adapter, listSessionCleanup } = harness({
      provider: null,
      sourceControl: null,
    });
    listSessionCleanup.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `cleanup-${index}`,
        provider: "modal" as const,
        status: "failed" as const,
        provider_image_id: null,
        provider_session_id: `session-${index}`,
        created_at: index,
      }))
    );
    let inFlight = 0;
    let peakInFlight = 0;
    adapter.cleanupFailedBuild.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.cleanupAttempted).toBe(12);
    expect(stats.cleanupSucceeded).toBe(12);
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });

  it("continues reconciliation and artifact cleanup when a cleanup phase query fails", async () => {
    const { scheduler, store } = harness();
    store.listSessionCleanup.mockRejectedValueOnce(new Error("D1 cleanup unavailable"));

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(1);
    expect(stats.triggered).toBe(1);
    expect(store.deleteOldFailedBuilds).toHaveBeenCalledOnce();
  });

  it("checks every enabled scope in one full scan", async () => {
    const getBranchHead = vi.fn(async () => "abc123");
    const { scheduler, store, resolveTarget, listScopes } = harness({
      sourceControl: { getBranchHead } as unknown as SourceControlProvider,
    });
    listScopes.mockResolvedValue(
      Array.from({ length: 41 }, (_, index) => ({
        kind: "repo" as const,
        id: `acme/repo-${index}`,
      }))
    );
    resolveTarget.mockImplementation(
      async (_env: Env, _db: SqlDatabase, scope: ImageBuildScope) => {
        return {
          kind: "repo",
          repoId: 1,
          repositories: [
            {
              repoOwner: "acme",
              repoName: scope.id.split("/").at(-1) ?? "repo",
              baseBranch: "main",
            },
          ],
          repositoriesFingerprint: `fp-${scope.id}`,
        };
      }
    );
    store.getReconciliationStatus.mockImplementation(async (scope: ImageBuildScope) => {
      const target = await resolveTarget({} as Env, {} as SqlDatabase, scope);
      return [
        {
          id: `build-${scope.id}`,
          scopeKind: scope.kind,
          scopeId: scope.id,
          provider: "modal",
          status: "ready",
          repositoriesFingerprint: target.repositoriesFingerprint,
          repositoryShas: target.repositories.map((repository) => ({
            repoOwner: repository.repoOwner,
            repoName: repository.repoName,
            baseSha: "abc123",
          })),
          runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
          buildDurationSeconds: 1,
          errorMessage: null,
          createdAt: 1,
        },
      ];
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(41);
    expect(stats.branchLookups).toBe(41);
  });

  it("starts every required build found by the full scan", async () => {
    const { scheduler, listScopes, workflow } = harness();
    listScopes.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        kind: "repo" as const,
        id: `acme/repo-${index}`,
      }))
    );

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(10);
    expect(stats.triggered).toBe(10);
    expect(workflow.triggerBuildWithTarget).toHaveBeenCalledTimes(10);
  });

  it("runs provider-neutral maintenance when rebuild reconciliation is unavailable", async () => {
    const { scheduler, store, listScopes } = harness({
      provider: null,
      sourceControl: null,
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.staleMarked).toBe(1);
    expect(stats.cleanupAttempted).toBe(2);
    expect(stats.scopesScanned).toBe(0);
    expect(listScopes).not.toHaveBeenCalled();
    expect(store.deleteOldFailedBuilds).toHaveBeenCalledOnce();
  });

  it("republishes persisted artifacts left behind by exhausted Queue delivery", async () => {
    const send = vi.fn(async () => undefined);
    const { scheduler, listRecoverableFinalizations } = harness({
      env: { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
    });
    listRecoverableFinalizations.mockResolvedValue([
      {
        id: "build-recover",
        completion_hash: "a".repeat(64),
        callback_token_used_at: 1,
      },
    ]);

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.finalizationsRepublished).toBe(1);
    expect(send).toHaveBeenCalledWith({
      version: 1,
      buildId: "build-recover",
      completionHash: "a".repeat(64),
    });
  });

  it("republishes every recoverable finalization and contains a publish failure", async () => {
    const send = vi.fn(async ({ buildId }: { buildId: string }) => {
      if (buildId === "build-05") throw new Error("queue unavailable");
    });
    const { scheduler, listRecoverableFinalizations } = harness({
      env: { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
    });
    const recoverable = Array.from({ length: 21 }, (_, index) => ({
      id: `build-${String(index + 1).padStart(2, "0")}`,
      completion_hash: `${index + 1}`.repeat(64).slice(0, 64),
      callback_token_used_at: index + 1,
    }));
    listRecoverableFinalizations.mockResolvedValue(recoverable);

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.finalizationsRepublished).toBe(20);
    expect(send).toHaveBeenCalledTimes(21);
    expect(listRecoverableFinalizations).toHaveBeenCalledWith(expect.any(Number));
    expect(send).toHaveBeenCalledWith({
      version: 1,
      buildId: "build-21",
      completionHash: "21".repeat(32),
    });
  });
});
