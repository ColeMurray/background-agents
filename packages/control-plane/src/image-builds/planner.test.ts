import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialScope } from "../source-control/credential-scope";
import {
  EnvironmentStore,
  type EnvironmentRepositoryRow,
  type EnvironmentRow,
} from "../db/environments";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { readCachedInstallationRepositories } from "../repos/cache";
import type * as ReposCacheModule from "../repos/cache";
import { createTestEnv } from "../router.test-support";
import type * as SourceControlModule from "../source-control";
import { resolveImageBuildTokenScope } from "./credential-scope";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import type { ImageBuildScope } from "./model";
import {
  ImageBuildPlanner,
  type ImageBuildPlanRequest,
  type ResolvedImageBuildTarget,
} from "./planner";
import type * as ScopeModule from "./scope";

const scmProvider = vi.hoisted(() => ({
  generateCredentialHelperAuth: vi.fn(async (_scope: CredentialScope) => ({
    username: "x-access-token",
    password: "clone-token",
  })),
}));

vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
}));

vi.mock("./scope", async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeModule>()),
  resolveScopeSandboxSettings: vi.fn(async () => ({})),
  loadScopeBuildSecrets: vi.fn(async () => undefined),
}));

vi.mock("../repos/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof ReposCacheModule>()),
  readCachedInstallationRepositories: vi.fn(),
}));

const db = {} as SqlDatabase;
const REPO_SCOPE: ImageBuildScope = { kind: "repo", id: "acme/web" };
const ENV_SCOPE: ImageBuildScope = { kind: "environment", id: "env_1" };
const REPO_TARGET: ResolvedImageBuildTarget = {
  kind: "repo",
  repoId: 12,
  repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
  repositoriesFingerprint: "fp-repo",
};
const ENV_TARGET: ResolvedImageBuildTarget = {
  kind: "environment",
  repositories: [
    ...REPO_TARGET.repositories,
    { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
  ],
  repositoriesFingerprint: "fp-env",
};
const ENVIRONMENT: EnvironmentRow = {
  id: ENV_SCOPE.id,
  name: "Environment",
  description: null,
  prebuild_enabled: 1,
  channel_associations: null,
  owner_team_id: null,
  created_at: 1,
  updated_at: 1,
};
const ENV_REPOSITORIES: EnvironmentRepositoryRow[] = ENV_TARGET.repositories.map(
  (repository, position) => ({
    environment_id: ENV_SCOPE.id,
    position,
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    repo_id: position === 0 ? 12 : 30,
    base_branch: repository.baseBranch,
  })
);
const CATALOG: InstallationRepository[] = [
  { id: 12, name: "web" },
  { id: 30, name: "api" },
  { id: 99, name: "sibling" },
].map((repository) => ({
  ...repository,
  owner: "acme",
  fullName: `acme/${repository.name}`,
  description: null,
  private: true,
  defaultBranch: "main",
  archived: false,
}));
const loadCatalog = vi.fn<() => Promise<InstallationRepository[]>>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(null);
  vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue([]);
  vi.mocked(readCachedInstallationRepositories).mockResolvedValue(CATALOG);
  scmProvider.generateCredentialHelperAuth.mockResolvedValue({
    username: "x-access-token",
    password: "clone-token",
  });
});

afterEach(() => vi.restoreAllMocks());

function mockEnvironment(
  ownerTeamId: string | null = null,
  repositories: EnvironmentRepositoryRow[] = ENV_REPOSITORIES
): void {
  vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
    ...ENVIRONMENT,
    owner_team_id: ownerTeamId,
  });
  vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue(
    repositories
  );
}

function planRequest(
  scope: ImageBuildScope,
  target: ResolvedImageBuildTarget
): ImageBuildPlanRequest {
  return {
    buildId: "build-1",
    scope,
    target,
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    correlation: { request_id: "request-1", trace_id: "trace-1" },
    callbackAuth: { token: "callback-token", tokenHash: "callback-hash", expiresAt: 1000 },
  };
}

describe("resolveImageBuildTokenScope", () => {
  it("scopes environments to their stored member ids", async () => {
    mockEnvironment();

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
  });

  it("intersects environment members with the owning team's grants", async () => {
    mockEnvironment("team_a");
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
      { grant_kind: "repository", repo_external_id: 99 },
    ]);

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team_a"
    );
  });

  it("accepts unchanged identities when member order or case differs", async () => {
    mockEnvironment(
      null,
      [...ENV_REPOSITORIES].reverse().map((row) => ({
        ...row,
        repo_owner: row.repo_owner.toUpperCase(),
        repo_name: row.repo_name.toUpperCase(),
      }))
    );

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
  });

  it.each([
    { name: "added", rows: [...ENV_REPOSITORIES, { ...ENV_REPOSITORIES[0], repo_name: "extra" }] },
    { name: "removed", rows: ENV_REPOSITORIES.slice(0, 1) },
    {
      name: "replaced",
      rows: [ENV_REPOSITORIES[0], { ...ENV_REPOSITORIES[1], repo_name: "sibling", repo_id: null }],
    },
  ])("fails closed when environment membership is $name", async ({ rows }) => {
    mockEnvironment("team_a", rows);

    await expect(
      resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET, loadCatalog)
    ).rejects.toBeInstanceOf(ImageBuildPlanningError);
  });

  it("fails closed when the environment no longer exists", async () => {
    await expect(
      resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET, loadCatalog)
    ).rejects.toBeInstanceOf(ImageBuildScopeNotFoundError);
  });

  it.each([{ repositories: [] }, { repositories: ENV_TARGET.repositories }])(
    "rejects repo targets without exactly one repository",
    async ({ repositories }) => {
      await expect(
        resolveImageBuildTokenScope(db, REPO_SCOPE, { ...REPO_TARGET, repositories }, loadCatalog)
      ).rejects.toBeInstanceOf(ImageBuildPlanningError);
    }
  );

  it.each([
    { scope: REPO_SCOPE, target: ENV_TARGET },
    { scope: ENV_SCOPE, target: REPO_TARGET },
  ])("rejects scope/target kind mismatches before reading stores", async ({ scope, target }) => {
    await expect(
      resolveImageBuildTokenScope(db, scope, target, loadCatalog)
    ).rejects.toBeInstanceOf(ImageBuildPlanningError);
    expect(EnvironmentStore.prototype.getById).not.toHaveBeenCalled();
  });
});

describe("ImageBuildPlanner clone auth", () => {
  it("mints a repository build token for that repository alone", async () => {
    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(REPO_SCOPE, REPO_TARGET)
    );

    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [12],
    });
    expect(plan.cloneAuth).toEqual({ type: "credential_helper", token: "clone-token" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("resolves NULL environment member ids from the cached catalog", async () => {
    mockEnvironment(
      null,
      ENV_REPOSITORIES.map((row) => ({ ...row, repo_id: null }))
    );
    const env = createTestEnv();

    const plan = await new ImageBuildPlanner(env, db).planBuild(planRequest(ENV_SCOPE, ENV_TARGET));

    expect(readCachedInstallationRepositories).toHaveBeenCalledExactlyOnceWith(env);
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(plan.cloneAuth.type).toBe("credential_helper");
  });

  it("does not mint a token for changed environment membership", async () => {
    mockEnvironment(null, [{ ...ENV_REPOSITORIES[0], repo_name: "sibling", repo_id: null }]);

    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(ENV_SCOPE, ENV_TARGET)
    );

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(scmProvider.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });

  it("does not retry a scoped credential failure with broader auth", async () => {
    scmProvider.generateCredentialHelperAuth.mockRejectedValueOnce(new Error("Token scope denied"));

    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(REPO_SCOPE, REPO_TARGET)
    );

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [12],
    });
  });
});
