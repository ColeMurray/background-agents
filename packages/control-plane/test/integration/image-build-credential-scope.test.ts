import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import type { ImageBuildScope } from "../../src/image-builds/model";
import { ImageBuildPlanner, type ResolvedImageBuildTarget } from "../../src/image-builds/planner";
import { REPOS_CACHE_KEY, reposCacheIdentity } from "../../src/repos/cache";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { seedTeam } from "./ownership-test-helpers";

const SCOPE: ImageBuildScope = { kind: "environment", id: "env_image_build_credentials" };
const WEB = {
  position: 0,
  repo_owner: "acme",
  repo_name: "web",
  repo_id: 12,
  base_branch: "main",
} satisfies EnvironmentRepositoryInsert;
const API = {
  ...WEB,
  position: 1,
  repo_name: "api",
  repo_id: 30,
  base_branch: "develop",
} satisfies EnvironmentRepositoryInsert;
const SIBLING = {
  ...WEB,
  position: 2,
  repo_name: "sibling",
  repo_id: 99,
} satisfies EnvironmentRepositoryInsert;
const plannerEnv = {
  ...createCloudflareEnv(env),
  SCM_PROVIDER: "github",
  GITHUB_APP_INSTALLATION_ID: "image-build-credential-scope",
};
const planner = new ImageBuildPlanner(plannerEnv, env.DB);
const environments = new EnvironmentStore(env.DB);
const grants = new TeamRepositoryGrantStore(env.DB);

beforeEach(async () => {
  await cleanD1Tables();
  await seedTeam("team_a");
  await seedTeam("team_b");
  await plannerEnv.REPOS_CACHE.put(
    REPOS_CACHE_KEY,
    JSON.stringify({
      scmIdentity: await reposCacheIdentity(plannerEnv),
      cachedAt: new Date().toISOString(),
      repos: [WEB, API, SIBLING].map((repository) => ({
        id: repository.repo_id,
        owner: repository.repo_owner,
        name: repository.repo_name,
        fullName: `${repository.repo_owner}/${repository.repo_name}`,
        description: null,
        private: true,
        archived: false,
        defaultBranch: repository.base_branch,
      })),
    })
  );
});
afterEach(() => vi.restoreAllMocks());

function seedEnvironment(
  ownerTeamId: string | null,
  repositories: EnvironmentRepositoryInsert[] = [WEB, API]
) {
  return environments.create(
    {
      id: SCOPE.id,
      name: "Image build credentials",
      description: null,
      owner_team_id: ownerTeamId,
      prebuild_enabled: 1,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    },
    repositories
  );
}

function grant(teamId: string, repository: EnvironmentRepositoryInsert & { repo_id: number }) {
  return grants.add(teamId, {
    kind: "repository",
    repoExternalId: repository.repo_id,
    owner: repository.repo_owner,
    name: repository.repo_name,
  });
}

function mockMint() {
  return vi
    .spyOn(GitHubSourceControlProvider.prototype, "generateCredentialHelperAuth")
    .mockResolvedValue({
      username: "x-access-token",
      password: "clone-token",
      expiresAtEpochMs: Date.now() + 60_000,
    });
}

function planBuild(target: ResolvedImageBuildTarget, scope: ImageBuildScope = SCOPE) {
  return planner.planBuild({
    buildId: "build-credentials",
    scope,
    target,
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    correlation: { request_id: "request-credentials", trace_id: "trace-credentials" },
    callbackAuth: { token: "callback-token", tokenHash: "callback-hash", expiresAt: 1000 },
  });
}

describe("environment image-build credentials over D1 and KV", () => {
  it.each(["stored", "cached"])(
    "intersects %s environment member IDs with only the current owning team's grants",
    async (ids) => {
      await grant("team_a", WEB);
      await grant("team_a", SIBLING);
      await grant("team_b", API);
      await seedEnvironment(
        "team_a",
        [WEB, API].map((repository) => ({
          ...repository,
          repo_id: ids === "cached" ? null : repository.repo_id,
        }))
      );
      const target = await planner.resolveTarget(SCOPE);
      const mint = mockMint();

      expect((await planBuild(target)).cloneAuth).toEqual({
        type: "credential_helper",
        token: "clone-token",
      });
      expect(mint).toHaveBeenCalledExactlyOnceWith({ kind: "repositories", repositoryIds: [12] });
    }
  );

  it.each([null, "team_a"])(
    "keeps owner %s credentials inside the environment even with installation-wide grants",
    async (ownerTeamId) => {
      await grants.add("team_a", { kind: "installation" });
      await seedEnvironment(
        ownerTeamId,
        [WEB, API].map((repository) => ({ ...repository, repo_id: null }))
      );
      const target = await planner.resolveTarget(SCOPE);
      const mint = mockMint();

      expect((await planBuild(target)).cloneAuth.type).toBe("credential_helper");
      expect(mint).toHaveBeenCalledExactlyOnceWith({
        kind: "repositories",
        repositoryIds: [12, 30],
      });
    }
  );

  it("observes grant revocations after resolveTarget and refuses an empty intersection", async () => {
    const webGrant = await grant("team_a", WEB);
    const apiGrant = await grant("team_a", API);
    await grant("team_a", SIBLING);
    await seedEnvironment("team_a");
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint();

    await grants.remove("team_a", webGrant.id);
    expect((await planBuild(target)).cloneAuth.type).toBe("credential_helper");
    expect(mint).toHaveBeenCalledExactlyOnceWith({ kind: "repositories", repositoryIds: [30] });

    await grants.remove("team_a", apiGrant.id);
    mint.mockClear();
    expect((await planBuild(target)).cloneAuth).toEqual({ type: "unavailable" });
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([null, "team_a"])(
    "uses current grants after ownership changes from %s between resolveTarget and planBuild",
    async (originalOwner) => {
      await grant("team_a", WEB);
      await grant("team_a", API);
      const apiGrant = await grant("team_b", API);
      await grant("team_b", SIBLING);
      await seedEnvironment(originalOwner);
      const target = await planner.resolveTarget(SCOPE);
      const mint = mockMint();

      // Ownership is not mutable through the environment update API.
      await env.DB.prepare("UPDATE environments SET owner_team_id = ? WHERE id = ?")
        .bind("team_b", SCOPE.id)
        .run();
      expect((await planBuild(target)).cloneAuth.type).toBe("credential_helper");
      expect(mint).toHaveBeenCalledExactlyOnceWith({ kind: "repositories", repositoryIds: [30] });

      await grants.remove("team_b", apiGrant.id);
      mint.mockClear();
      expect((await planBuild(target)).cloneAuth).toEqual({ type: "unavailable" });
      expect(mint).not.toHaveBeenCalled();
    }
  );

  it.each([
    { change: "added", repositories: [WEB, API, SIBLING] },
    { change: "removed", repositories: [WEB] },
    { change: "replaced", repositories: [WEB, { ...SIBLING, position: 1 }] },
    { change: "owner changed", repositories: [WEB, { ...API, repo_owner: "other" }] },
    { change: "environment deleted", repositories: null },
  ])("does not mint when membership is $change after resolveTarget", async ({ repositories }) => {
    await grants.add("team_a", { kind: "installation" });
    await seedEnvironment("team_a");
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint();

    if (repositories === null) await environments.delete(SCOPE.id);
    else await environments.replaceRepositories(SCOPE.id, repositories);

    expect((await planBuild(target)).cloneAuth).toEqual({ type: "unavailable" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("accepts case/order edits and keeps the planned members", async () => {
    await grants.add("team_a", { kind: "installation" });
    await seedEnvironment("team_a");
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint();
    await environments.replaceRepositories(
      SCOPE.id,
      [API, WEB].map((repository, position) => ({
        ...repository,
        position,
        repo_owner: repository.repo_owner.toUpperCase(),
        repo_name: repository.repo_name.toUpperCase(),
        repo_id: null,
      }))
    );

    const plan = await planBuild(target);
    expect(plan.repositories).toEqual(target.repositories);
    expect(plan.cloneAuth.type).toBe("credential_helper");
    expect(mint).toHaveBeenCalledExactlyOnceWith({ kind: "repositories", repositoryIds: [12, 30] });
  });

  it("fails closed when a scope kind changes after resolving an environment target", async () => {
    await seedEnvironment(null);
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint();

    expect((await planBuild(target, { kind: "repo", id: "acme/web" })).cloneAuth).toEqual({
      type: "unavailable",
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it("does not mint when a legacy member ID is absent from the cached catalog", async () => {
    await grants.add("team_a", { kind: "installation" });
    await seedEnvironment("team_a", [WEB, { ...API, repo_name: "uncatalogued", repo_id: null }]);
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint();

    expect((await planBuild(target)).cloneAuth).toEqual({ type: "unavailable" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("never retries a denied environment-scoped mint with broader credentials", async () => {
    await grant("team_a", WEB);
    await grant("team_a", SIBLING);
    await seedEnvironment("team_a");
    const target = await planner.resolveTarget(SCOPE);
    const mint = mockMint().mockRejectedValueOnce(new Error("Token scope denied"));

    expect((await planBuild(target)).cloneAuth).toEqual({ type: "unavailable" });
    expect(mint).toHaveBeenCalledExactlyOnceWith({ kind: "repositories", repositoryIds: [12] });
  });
});
