import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { SqlDatabase } from "../db/sql-database";
import type { SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import type { ImageBuildScope } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildScheduler } from "./scheduler";
import type { ResolvedImageBuildTarget } from "./scope";
import type { ImageBuildWorkflow } from "./workflow";

function harness(
  options: {
    provider?: "modal" | null;
    sourceControl?: SourceControlProvider | null;
    env?: Env;
  } = {}
) {
  const getScopeCursor = vi.fn(
    async (_name: string): Promise<{ kind: "environment" | "repo"; id: string } | null> => null
  );
  const setScopeCursor = vi.fn(
    async (
      _name: string,
      _cursor: { kind: "environment" | "repo"; id: string } | null
    ): Promise<void> => undefined
  );
  const getRowCursor = vi.fn(
    async (_name: string): Promise<{ sortValue: number; rowId: string } | null> => null
  );
  const setRowCursor = vi.fn(
    async (_name: string, _cursor: { sortValue: number; rowId: string } | null): Promise<void> =>
      undefined
  );
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
  const listEnabledScopeRefsPage = vi.fn(
    async (): Promise<{
      scopes: ImageBuildScope[];
      nextCursor: { scopeKind: ImageBuildScope["kind"]; scopeId: string } | null;
    }> => ({
      scopes: [{ kind: "repo", id: "acme/web" }],
      nextCursor: null,
    })
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
    listProviderSessionCleanupPage,
    clearProviderSessionCleanup,
    listEnabledScopeRefsPage,
    maintenance: {
      getScopeCursor,
      setScopeCursor,
      getRowCursor,
      setRowCursor,
      listSessionCleanupPage: listProviderSessionCleanupPage,
      listEnabledScopeRefsPage,
      listRecoverableFinalizations,
    },
    finalization: {
      clearSessionCleanup: clearProviderSessionCleanup,
    },
    getReconciliationStatus,
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
    triggerBuildWithTarget: vi.fn(async () => ({
      type: "triggered" as const,
      buildId: "build-new",
    })),
    cleanupImages: vi.fn(async () => ({
      deletedFailed: 2,
      reapedFailed: 1,
      reapedSuperseded: 1,
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
    resolveTarget
  );
  return { scheduler, store, adapter, workflow, resolveTarget, listRecoverableFinalizations };
}

describe("ImageBuildScheduler", () => {
  it("contains cleanup failures, advances fairness, and still dispatches rebuilds", async () => {
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
    expect(store.maintenance.setRowCursor).toHaveBeenCalledWith("session-cleanup", null);
    expect(store.maintenance.setRowCursor.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.cleanupFailedBuild.mock.invocationCallOrder[0]
    );
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

  it("continues reconciliation and artifact cleanup when a cleanup phase query fails", async () => {
    const { scheduler, store, workflow } = harness();
    store.maintenance.getRowCursor.mockRejectedValueOnce(
      new Error("D1 cleanup cursor unavailable")
    );

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(1);
    expect(stats.triggered).toBe(1);
    expect(workflow.cleanupImages).toHaveBeenCalledOnce();
  });

  it("budgets branch checks independently from one scope's repository cap", async () => {
    const getBranchHead = vi.fn(async () => "abc123");
    const { scheduler, store, resolveTarget } = harness({
      sourceControl: { getBranchHead } as unknown as SourceControlProvider,
    });
    store.maintenance.listEnabledScopeRefsPage.mockResolvedValue({
      scopes: [
        { kind: "environment", id: "env-many" },
        { kind: "repo", id: "acme/next" },
      ],
      nextCursor: null,
    });
    resolveTarget.mockImplementation(
      async (_env: Env, _db: SqlDatabase, scope: ImageBuildScope) => {
        const repositories =
          scope.id === "env-many"
            ? Array.from({ length: 10 }, (_, index) => ({
                repoOwner: "acme",
                repoName: `repo-${index}`,
                baseBranch: "main",
              }))
            : [{ repoOwner: "acme", repoName: "next", baseBranch: "main" }];
        const target = {
          repositories,
          repositoriesFingerprint: `fp-${scope.id}`,
        };
        return scope.kind === "repo"
          ? { kind: "repo", repoId: 1, ...target }
          : { kind: "environment", ...target };
      }
    );
    store.getReconciliationStatus.mockImplementation(async (scope: ImageBuildScope) => {
      const target = await resolveTarget({} as Env, {} as SqlDatabase, scope);
      return [
        {
          id: `build-${scope.id}`,
          scope_kind: scope.kind,
          scope_id: scope.id,
          provider: "modal",
          status: "ready",
          repositories_fingerprint: target.repositoriesFingerprint,
          repository_shas: JSON.stringify(
            target.repositories.map((repository) => ({
              repoOwner: repository.repoOwner,
              repoName: repository.repoName,
              baseSha: "abc123",
            }))
          ),
          runtime_version: "v53-runtime",
          build_duration_seconds: 1,
          error_message: null,
          created_at: 1,
        },
      ];
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(2);
    expect(stats.branchLookups).toBe(11);
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

  it("rotates finalization recovery pages and contains a mid-page publish failure", async () => {
    const send = vi.fn(async ({ buildId }: { buildId: string }) => {
      if (buildId === "build-05") throw new Error("queue unavailable");
    });
    const { scheduler, store, listRecoverableFinalizations } = harness({
      env: { IMAGE_BUILD_FINALIZATION_QUEUE: { send } } as unknown as Env,
    });
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `build-${String(index + 1).padStart(2, "0")}`,
      completion_hash: `${index + 1}`.repeat(64).slice(0, 64),
      callback_token_used_at: index + 1,
    }));
    listRecoverableFinalizations.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([
      {
        id: "build-21",
        completion_hash: "b".repeat(64),
        callback_token_used_at: 21,
      },
    ]);

    const first = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });
    const recoveryCursor = store.maintenance.setRowCursor.mock.calls.find(
      ([name]) => name === "finalization-recovery"
    )?.[1];
    if (!recoveryCursor) throw new Error("expected finalization recovery cursor");
    store.maintenance.getRowCursor.mockImplementation(async (name) =>
      name === "finalization-recovery" ? recoveryCursor : null
    );
    const second = await scheduler.run({ request_id: "cron-2", trace_id: "cron-2" });

    expect(first.finalizationsRepublished).toBe(19);
    expect(second.finalizationsRepublished).toBe(1);
    expect(recoveryCursor).toEqual({ sortValue: 20, rowId: "build-20" });
    expect(listRecoverableFinalizations).toHaveBeenNthCalledWith(2, {
      now: expect.any(Number),
      after: { callbackTokenUsedAt: 20, rowId: "build-20" },
      limit: 20,
    });
    expect(send).toHaveBeenCalledWith({
      version: 1,
      buildId: "build-21",
      completionHash: "b".repeat(64),
    });
    expect(store.maintenance.setRowCursor.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]
    );
  });
});
