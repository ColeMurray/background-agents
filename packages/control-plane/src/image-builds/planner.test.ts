import type { Team } from "@open-inspect/shared/types/teams";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialScope } from "../source-control/credential-scope";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
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
  repositories: REPO_TARGET.repositories,
  repositoriesFingerprint: "fp-env",
};
const TEAM: Team = {
  id: "team_a",
  slug: "team-a",
  name: "Team A",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(TeamStore.prototype, "list").mockResolvedValue([]);
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(null);
  scmProvider.generateCredentialHelperAuth.mockResolvedValue({
    username: "x-access-token",
    password: "clone-token",
  });
});

afterEach(() => vi.restoreAllMocks());

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
  it("unions both granting teams' siblings, includes archived teams, and excludes unrelated teams", async () => {
    vi.mocked(TeamStore.prototype.list).mockResolvedValue([
      {
        ...TEAM,
        get grantsVersion(): number {
          throw new Error("Token scopes must not read grantsVersion");
        },
      },
      { ...TEAM, id: "team_b", archivedAt: 2 },
      { ...TEAM, id: "team_unrelated" },
    ]);
    const grants = new Map([
      ["team_a", [30, 12, 30]],
      ["team_b", [12, 2]],
      ["team_unrelated", [99]],
    ]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) => {
      return (grants.get(teamId) ?? []).map((repo_external_id) => ({
        grant_kind: "repository" as const,
        repo_external_id,
      }));
    });

    expect(await resolveImageBuildTokenScope(db, REPO_SCOPE, REPO_TARGET)).toEqual({
      kind: "repositories",
      repositoryIds: [2, 12, 30],
    });
    expect(TeamStore.prototype.list).toHaveBeenCalledWith({ includeArchived: true });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledTimes(3);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("team_unrelated");
  });

  it("uses installation access when an installation grant grants the target", async () => {
    vi.mocked(TeamStore.prototype.list).mockResolvedValue([TEAM]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
      { grant_kind: "repository", repo_external_id: 99 },
    ]);

    expect(await resolveImageBuildTokenScope(db, REPO_SCOPE, REPO_TARGET)).toEqual({ kind: "all" });
  });

  it.each(["no teams", "empty grants", "unrelated grants"])(
    "returns an empty repository scope for %s instead of broadening access",
    async (scenario) => {
      vi.mocked(TeamStore.prototype.list).mockResolvedValue(scenario === "no teams" ? [] : [TEAM]);
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue(
        scenario === "unrelated grants" ? [{ grant_kind: "repository", repo_external_id: 99 }] : []
      );

      expect(await resolveImageBuildTokenScope(db, REPO_SCOPE, REPO_TARGET)).toEqual({
        kind: "repositories",
        repositoryIds: [],
      });
    }
  );

  it("rejects malformed sibling grants rather than omitting them or broadening access", async () => {
    vi.mocked(TeamStore.prototype.list).mockResolvedValue([TEAM]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
      { grant_kind: "repository", repo_external_id: null },
    ]);

    await expect(resolveImageBuildTokenScope(db, REPO_SCOPE, REPO_TARGET)).rejects.toThrow();
  });

  it("keeps a workspace-owned environment installation-wide without reading grants", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(ENVIRONMENT);

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET)).toEqual({ kind: "all" });
    expect(EnvironmentStore.prototype.getById).toHaveBeenCalledWith(ENV_SCOPE.id);
    expect(TeamStore.prototype.list).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("uses only the environment owner's grants, including siblings", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...ENVIRONMENT,
      owner_team_id: TEAM.id,
    });
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 30 },
      { grant_kind: "repository", repo_external_id: 12 },
    ]);

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(TEAM.id);
    expect(TeamStore.prototype.list).not.toHaveBeenCalled();
  });

  it("keeps a team-owned environment without grants empty", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...ENVIRONMENT,
      owner_team_id: TEAM.id,
    });

    expect(await resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET)).toEqual({
      kind: "repositories",
      repositoryIds: [],
    });
  });

  it("fails closed when the environment no longer exists", async () => {
    await expect(resolveImageBuildTokenScope(db, ENV_SCOPE, ENV_TARGET)).rejects.toBeInstanceOf(
      ImageBuildScopeNotFoundError
    );
    expect(TeamStore.prototype.list).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it.each([
    { scope: REPO_SCOPE, target: ENV_TARGET },
    { scope: ENV_SCOPE, target: REPO_TARGET },
  ])("rejects scope/target kind mismatches before reading stores", async ({ scope, target }) => {
    await expect(resolveImageBuildTokenScope(db, scope, target)).rejects.toBeInstanceOf(
      ImageBuildPlanningError
    );
    expect(EnvironmentStore.prototype.getById).not.toHaveBeenCalled();
    expect(TeamStore.prototype.list).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });
});

describe("ImageBuildPlanner clone auth", () => {
  it("passes the resolved repository scope to credential generation", async () => {
    vi.mocked(TeamStore.prototype.list).mockResolvedValue([TEAM]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
      { grant_kind: "repository", repo_external_id: 30 },
    ]);

    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(REPO_SCOPE, REPO_TARGET)
    );

    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(plan.cloneAuth).toEqual({
      type: "credential_helper",
      host: "github.com",
      username: "x-access-token",
      token: "clone-token",
    });
  });

  it("maps missing environments to unavailable auth without minting a fallback", async () => {
    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(ENV_SCOPE, ENV_TARGET)
    );

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(scmProvider.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });

  it("maps grant-read failures to unavailable auth without minting a fallback", async () => {
    vi.mocked(TeamStore.prototype.list).mockResolvedValue([TEAM]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockRejectedValueOnce(
      new Error("Grant store unavailable")
    );

    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(REPO_SCOPE, REPO_TARGET)
    );

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(scmProvider.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });

  it("does not retry an empty scope with broader auth when minting refuses it", async () => {
    scmProvider.generateCredentialHelperAuth.mockRejectedValueOnce(new Error("Empty token scope"));

    const plan = await new ImageBuildPlanner(createTestEnv(), db).planBuild(
      planRequest(REPO_SCOPE, REPO_TARGET)
    );

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [],
    });
  });
});
