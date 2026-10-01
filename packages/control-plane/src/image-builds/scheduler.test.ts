import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore, type EnvironmentRepositoryRow } from "../db/environments";
import type { ImageBuildStore } from "../db/image-builds";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { Job } from "../jobs";
import { loadInstallationRepositories } from "../repos/cache";
import type * as ReposCacheModule from "../repos/cache";
import { createTestEnv } from "../router.test-support";
import type { SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import type { ImageBuildScope } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildScheduler } from "./scheduler";
import type { ResolvedImageBuildTarget } from "./scope";
import { COMPATIBLE_RUNTIME_VERSION } from "./test-helpers";
import type { ImageBuildWorkflow } from "./workflow";

vi.mock("../repos/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof ReposCacheModule>()),
  loadInstallationRepositories: vi.fn(),
}));

const ENVIRONMENT = {
  id: "env_1",
  name: "Environment",
  description: null,
  prebuild_enabled: 1,
  channel_associations: null,
  owner_team_id: null,
  created_at: 1,
  updated_at: 1,
};
const ENV_TARGET: ResolvedImageBuildTarget = {
  kind: "environment",
  repositories: [
    { repoOwner: "acme", repoName: "web", baseBranch: "main" },
    { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
  ],
  repositoriesFingerprint: "fp-env",
};
const ENV_REPOSITORIES: EnvironmentRepositoryRow[] = ENV_TARGET.repositories.map(
  (repository, position) => ({
    environment_id: ENVIRONMENT.id,
    position,
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    repo_id: position + 1,
    base_branch: repository.baseBranch,
  })
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(null);
  vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue(
    ENV_REPOSITORIES
  );
  vi.mocked(loadInstallationRepositories).mockResolvedValue(
    [
      { id: 1, name: "web" },
      { id: 2, name: "api" },
      { id: 99, name: "sibling" },
    ].map((repository) => ({
      ...repository,
      owner: "acme",
      fullName: `acme/${repository.name}`,
      description: null,
      private: true,
      defaultBranch: "main",
      archived: false,
    }))
  );
});

afterEach(() => vi.restoreAllMocks());

function harness(
  options: {
    provider?: "modal" | "daytona" | null;
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
    listUnboundSourceIntents: vi.fn(async () => []),
    listUnresolvedOperations: vi.fn(async () => []),
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
    options.env ?? createTestEnv(),
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

function mockReadyImages({ store, resolveTarget }: ReturnType<typeof harness>): void {
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
    const h = harness({
      sourceControl: { getBranchHead } as unknown as SourceControlProvider,
    });
    const { scheduler, resolveTarget, listScopes } = h;
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
    mockReadyImages(h);

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(41);
    expect(stats.branchLookups).toBe(41);
    expect(getBranchHead).toHaveBeenCalledWith(
      { owner: "acme", name: "repo-40", branch: "main" },
      { kind: "repositories", repositoryIds: [1] }
    );
  });

  it("reads a repo branch with exactly one repository even without teams or grants", async () => {
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(getBranchHead).toHaveBeenCalledExactlyOnceWith(
      { owner: "acme", name: "web", branch: "main" },
      { kind: "repositories", repositoryIds: [1] }
    );
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    expect(loadInstallationRepositories).not.toHaveBeenCalled();
    expect(stats.branchMatched).toBe(1);
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
  });

  it("never broadens repo branch scope to installation coverage", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    mockReadyImages(h);

    await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(getBranchHead).toHaveBeenCalledExactlyOnceWith(
      { owner: "acme", name: "web", branch: "main" },
      { kind: "repositories", repositoryIds: [1] }
    );
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it.each([null, "team_a"])(
    "uses only environment members for all branch reads (owner %s)",
    async (ownerTeamId) => {
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        ...ENVIRONMENT,
        owner_team_id: ownerTeamId,
      });
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
        { grant_kind: "installation", repo_external_id: null },
        { grant_kind: "repository", repo_external_id: 99 },
      ]);
      const getBranchHead = vi.fn(async () => "abc123");
      const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
      h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
      h.resolveTarget.mockResolvedValue(ENV_TARGET);
      mockReadyImages(h);

      const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

      const expectedScope = { kind: "repositories", repositoryIds: [1, 2] };
      expect(getBranchHead).toHaveBeenNthCalledWith(
        1,
        { owner: "acme", name: "web", branch: "main" },
        expectedScope
      );
      expect(getBranchHead).toHaveBeenNthCalledWith(
        2,
        { owner: "acme", name: "api", branch: "develop" },
        expectedScope
      );
      expect(EnvironmentStore.prototype.getById).toHaveBeenCalledExactlyOnceWith("env_1");
      expect(loadInstallationRepositories).not.toHaveBeenCalled();
      if (ownerTeamId === null) {
        expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      } else {
        expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
          ownerTeamId
        );
      }
      expect(stats.branchMatched).toBe(2);
    }
  );

  it("resolves NULL environment ids lazily from the installation catalog for branch reads", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(ENVIRONMENT);
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue(
      ENV_REPOSITORIES.map((row) => ({ ...row, repo_id: null }))
    );
    const getBranchHead = vi.fn(async () => "abc123");
    const env = createTestEnv();
    const h = harness({
      env,
      sourceControl: { getBranchHead } as unknown as SourceControlProvider,
    });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue(ENV_TARGET);
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(loadInstallationRepositories).toHaveBeenCalledExactlyOnceWith(env, expect.anything());
    expect(getBranchHead).toHaveBeenCalledTimes(2);
    expect(getBranchHead).toHaveBeenCalledWith(expect.any(Object), {
      kind: "repositories",
      repositoryIds: [1, 2],
    });
    expect(stats.branchMatched).toBe(2);
  });

  it("drops members revoked from the owning team's branch credential scope", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...ENVIRONMENT,
      owner_team_id: "team_a",
    });
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 1 },
      { grant_kind: "repository", repo_external_id: 99 },
    ]);
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue(ENV_TARGET);
    mockReadyImages(h);

    await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(getBranchHead).toHaveBeenCalledTimes(2);
    expect(getBranchHead).toHaveBeenNthCalledWith(
      1,
      { owner: "acme", name: "web", branch: "main" },
      { kind: "repositories", repositoryIds: [1] }
    );
    expect(getBranchHead).toHaveBeenNthCalledWith(
      2,
      { owner: "acme", name: "api", branch: "develop" },
      { kind: "repositories", repositoryIds: [1] }
    );
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team_a"
    );
  });

  it("does not read branches or rebuild after all environment grants are revoked", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...ENVIRONMENT,
      owner_team_id: "team_a",
    });
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue(ENV_TARGET);
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.branchLookups).toBe(0);
    expect(getBranchHead).not.toHaveBeenCalled();
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team_a"
    );
  });

  it("skips branch reads and rebuilds after environment membership changes", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(ENVIRONMENT);
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
      ENV_REPOSITORIES[0],
      { ...ENV_REPOSITORIES[1], repo_name: "sibling", repo_id: null },
    ]);
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue(ENV_TARGET);
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(1);
    expect(stats.branchLookups).toBe(0);
    expect(getBranchHead).not.toHaveBeenCalled();
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
    expect(loadInstallationRepositories).not.toHaveBeenCalled();
  });

  it("skips branch reads and rebuilds for NULL ids missing from the catalog", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(ENVIRONMENT);
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue(
      ENV_REPOSITORIES.map((row) => ({ ...row, repo_id: null }))
    );
    vi.mocked(loadInstallationRepositories).mockResolvedValueOnce([]);
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue(ENV_TARGET);
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.branchLookups).toBe(0);
    expect(getBranchHead).not.toHaveBeenCalled();
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
  });

  it("does not read branches or rebuild when the environment no longer exists", async () => {
    const getBranchHead = vi.fn(async () => "abc123");
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    h.listScopes.mockResolvedValue([{ kind: "environment", id: "env_1" }]);
    h.resolveTarget.mockResolvedValue({
      kind: "environment",
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-env",
    });
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.scopesScanned).toBe(1);
    expect(stats.branchLookups).toBe(0);
    expect(getBranchHead).not.toHaveBeenCalled();
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
  });

  it("does not broaden repository scope when the provider refuses branch auth", async () => {
    const getBranchHead = vi.fn(async () => {
      throw new Error("Token scope denied");
    });
    const h = harness({ sourceControl: { getBranchHead } as unknown as SourceControlProvider });
    mockReadyImages(h);

    const stats = await h.scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(getBranchHead).toHaveBeenCalledExactlyOnceWith(
      { owner: "acme", name: "web", branch: "main" },
      { kind: "repositories", repositoryIds: [1] }
    );
    expect(stats.branchUnknown).toBe(1);
    expect(h.workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
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
      env: createTestEnv({ JOBS: { send } }),
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
      kind: "image_build.finalize",
      payload: { version: 1, buildId: "build-recover", completionHash: "a".repeat(64) },
    });
  });

  it("republishes every recoverable finalization and contains a publish failure", async () => {
    const send = vi.fn(async (job: Job) => {
      if (job.kind === "image_build.finalize" && job.payload.buildId === "build-05") {
        throw new Error("queue unavailable");
      }
    });
    const { scheduler, listRecoverableFinalizations } = harness({
      env: createTestEnv({ JOBS: { send } }),
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
      kind: "image_build.finalize",
      payload: { version: 1, buildId: "build-21", completionHash: "21".repeat(32) },
    });
  });
});

describe("ImageBuildScheduler admission", () => {
  it("keeps every maintenance phase running while new builds are paused", async () => {
    const { scheduler, store, listScopes, workflow } = harness({
      provider: "daytona",
      env: createTestEnv({ SANDBOX_PROVIDER: "daytona" }),
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.admissionOpen).toBe(false);
    // No new builds...
    expect(listScopes).not.toHaveBeenCalled();
    expect(workflow.triggerBuildWithTarget).not.toHaveBeenCalled();
    // ...but everything that reclaims what already exists still runs.
    expect(stats.staleMarked).toBe(1);
    expect(stats.cleanupAttempted).toBe(2);
    expect(store.deleteOldFailedBuilds).toHaveBeenCalledOnce();
  });

  it("reconciles scopes again once admission opens", async () => {
    const { scheduler, listScopes } = harness({
      provider: "daytona",
      env: createTestEnv({ SANDBOX_PROVIDER: "daytona", DAYTONA_PREBUILDS_ENABLED: "true" }),
    });

    const stats = await scheduler.run({ request_id: "cron-1", trace_id: "cron-1" });

    expect(stats.admissionOpen).toBe(true);
    expect(listScopes).toHaveBeenCalled();
  });
});
