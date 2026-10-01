import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import {
  authorizationDatabase,
  createRepositoryGrantEnv,
  createRepositoryGrantRequest,
  setupRepositoryGrantSpies,
} from "./repository-grants.test-support";
import { AuthorizationStore } from "../db/authorization-store";
import { EnvironmentStore } from "../db/environments";
import { RepoMetadataStore } from "../db/repo-metadata";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type * as SourceControlModule from "../source-control";
import type { Env } from "../types";
import { imageBuildRoutes } from "./image-builds";

const mocks = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  triggerBuild: vi.fn(),
  scheduleImageBuildOnSave: vi.fn(),
}));
vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: mocks.checkRepositoryAccess,
  }),
}));
vi.mock("../image-builds/workflow", () => ({
  createImageBuildWorkflowFromEnv: () => ({
    triggerBuild: mocks.triggerBuild,
    triggerBuildWithTarget: mocks.triggerBuild,
  }),
}));
vi.mock("../image-builds/save-hooks", () => ({
  scheduleImageBuildOnSave: mocks.scheduleImageBuildOnSave,
}));

const env = () =>
  createRepositoryGrantEnv(["repositories.images.manage", "environments.images.manage"]);
const request = createRepositoryGrantRequest(imageBuildRoutes, env);
const repositoryImageWrites = [
  ["POST", "/image-builds/trigger/repo/acme/repo", undefined],
  ["PUT", "/image-builds/toggle/repo/acme/repo", { enabled: true }],
] as const;
const environmentRow = {
  id: "env-1",
  owner_team_id: "owner-team",
  name: "Environment",
  description: null,
  prebuild_enabled: 0,
  channel_associations: null,
  created_at: 1,
  updated_at: 1,
};
const environmentRepository = {
  environment_id: "env-1",
  position: 0,
  repo_owner: "acme",
  repo_name: "repo",
  repo_id: 123,
  base_branch: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  setupRepositoryGrantSpies();
  mocks.checkRepositoryAccess.mockResolvedValue({
    repoId: 123,
    repoOwner: "acme",
    repoName: "repo",
    defaultBranch: "main",
  });
  mocks.triggerBuild.mockResolvedValue({ type: "building", buildId: "build-1" });
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(environmentRow);
  vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue([
    environmentRepository,
  ]);
  vi.spyOn(RepoMetadataStore.prototype, "setImageBuildEnabled").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("image build repository-bearing writes", () => {
  it("denies a repo trigger before invoking the workflow", async () => {
    expect((await request("/image-builds/trigger/repo/acme/repo", "POST")).status).toBe(403);
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });
  it("denies toggle-on before writing or scheduling", async () => {
    expect(
      (await request("/image-builds/toggle/repo/acme/repo", "PUT", { enabled: true })).status
    ).toBe(403);
    expect(RepoMetadataStore.prototype.setImageBuildEnabled).not.toHaveBeenCalled();
    expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });
  it("denies an environment trigger when its persisted owner lacks grants", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "team-1" ? [{ grant_kind: "installation", repo_external_id: null }] : []
    );
    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(409);
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });
  it("allows a granted repo trigger with images.manage alone", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);
    expect((await request("/image-builds/trigger/repo/acme/repo", "POST")).status).toBe(200);
    expect(mocks.triggerBuild).toHaveBeenCalledOnce();
    expect(mocks.triggerBuild).toHaveBeenCalledWith(
      { kind: "repo", id: "acme/repo" },
      expect.objectContaining({ kind: "repo", repoId: 123 }),
      expect.objectContaining({ request_id: expect.any(String) })
    );
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
  });
  it("allows an owning-team member to enable repo images with images.manage alone", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);

    expect(
      (await request("/image-builds/toggle/repo/acme/repo", "PUT", { enabled: true })).status
    ).toBe(200);
    expect(RepoMetadataStore.prototype.setImageBuildEnabled).toHaveBeenCalledWith(
      "acme",
      "repo",
      true
    );
    expect(mocks.scheduleImageBuildOnSave).toHaveBeenCalledOnce();
  });
  it("allows disabling without SCM resolution or a surviving grant", async () => {
    mocks.checkRepositoryAccess.mockRejectedValue(new Error("Repository gone"));
    expect(
      (await request("/image-builds/toggle/repo/acme/repo", "PUT", { enabled: false })).status
    ).toBe(200);
    expect(RepoMetadataStore.prototype.setImageBuildEnabled).toHaveBeenCalledWith(
      "acme",
      "repo",
      false
    );
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
  });
  it("preserves workspace-owned environment trigger behavior", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...environmentRow,
      owner_team_id: null,
    });
    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(200);
    expect(mocks.triggerBuild).toHaveBeenCalledOnce();
  });

  it("checks every current repository against the environment owner regardless of persisted IDs", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
      environmentRepository,
      {
        ...environmentRepository,
        position: 1,
        repo_name: "other",
        repo_id: null,
      },
    ]);
    mocks.checkRepositoryAccess.mockImplementation(
      async ({ owner, name }: { owner: string; name: string }) => ({
        repoId: name === "other" ? 456 : 123,
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
      })
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
    );
    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(409);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "other" });
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledTimes(2);
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });

  it("rejects a reused environment repository name when only the persisted old ID is granted", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    mocks.checkRepositoryAccess.mockResolvedValue({
      repoId: 456,
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
    });
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
    );

    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(409);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });

  it("allows the current environment repository ID when the persisted ID is stale", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    mocks.checkRepositoryAccess.mockResolvedValue({
      repoId: 456,
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
    });
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 456 }] : []
    );

    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(200);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(mocks.triggerBuild).toHaveBeenCalledOnce();
  });

  it("rejects a disappeared environment repository despite its persisted ID and grant", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    mocks.checkRepositoryAccess.mockResolvedValue(null);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
    ]);

    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(404);
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });

  it("allows an environment owner-team member with only environments.images.manage", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([
        ["team-1", "member"],
        ["owner-team", "member"],
      ])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
    );
    const environment = env();
    environment.DB = authorizationDatabase({ permissions: ["environments.images.manage"] });
    expect(
      (await request("/image-builds/trigger/environment/env-1", "POST", undefined, environment))
        .status
    ).toBe(200);
    expect(mocks.triggerBuild).toHaveBeenCalledOnce();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalledWith("team-1");
  });

  it.each(["off", "shadow", "on"] as const)(
    "denies a nonmember before SCM access in %s mode even when the owner team has grants",
    async (mode) => {
      const environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
        { grant_kind: "installation", repo_external_id: null },
      ]);
      const response = await request(
        "/image-builds/trigger/environment/env-1",
        "POST",
        undefined,
        environment
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Forbidden",
        code: "not_member",
        reason_code: "not_member",
      });
      expect(EnvironmentStore.prototype.getRepositoriesForEnvironment).not.toHaveBeenCalled();
      expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      expect(mocks.triggerBuild).not.toHaveBeenCalled();
    }
  );

  it("denies an environment trigger for a caller without any team membership", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
    ]);

    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(403);
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });

  it("denies an unrelated team lead even when their own team has an installation grant", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["team-1", "lead"]])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);

    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(403);
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(mocks.triggerBuild).not.toHaveBeenCalled();
  });
});

describe.each(["off", "shadow", "on"] as const)(
  "workspace image build repository ownership in %s mode",
  (mode) => {
    let environment: Env;
    beforeEach(() => {
      environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
    });

    it.each(repositoryImageWrites)(
      "allows image %s with no grants anywhere and only existing permissions",
      async (method, path, body) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        expect((await request(path, method, body, environment)).status).toBe(200);
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      }
    );

    it.each(["member", "lead", null] as const)(
      "denies another team's repositories for an unrelated %s across image routes",
      async (role) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          role === null ? new Map() : new Map([["team-1", role]])
        );
        for (const [method, path, body] of repositoryImageWrites) {
          expect((await request(path, method, body, environment)).status).toBe(403);
        }
        expect(RepoMetadataStore.prototype.setImageBuildEnabled).not.toHaveBeenCalled();
        expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
        expect(mocks.triggerBuild).not.toHaveBeenCalled();
      }
    );

    it("preserves workspace-owned trigger with only its existing custom-role permission", async () => {
      environment.DB = authorizationDatabase({ permissions: ["environments.images.manage"] });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        ...environmentRow,
        owner_team_id: null,
      });

      expect(
        (await request("/image-builds/trigger/environment/env-1", "POST", undefined, environment))
          .status
      ).toBe(200);
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
    });
  }
);

describe.each(["owner", "administrator"] as const)(
  "built-in %s image build repository authorization",
  (key) => {
    beforeEach(() => {
      vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
        userId: "user-1",
        suspendedAt: null,
        role: { ...BUILT_IN_ROLE_REGISTRY[key], name: key },
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    });

    it.each(repositoryImageWrites)(
      "allows image %s for another team's repository without membership",
      async (method, path, body) => {
        expect((await request(path, method, body)).status).toBe(200);
      }
    );

    it("allows a team-owned environment trigger when the owner team has a covering grant", async () => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
        async (teamId) =>
          teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
      );

      expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(200);
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
      expect(mocks.triggerBuild).toHaveBeenCalledOnce();
    });

    it("cannot build an environment repository missing the owner team's grant", async () => {
      const response = await request("/image-builds/trigger/environment/env-1", "POST");

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Target team lacks repository grant",
        code: "target_team_missing_grant",
        repository: "acme/repo",
      });
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
      expect(mocks.triggerBuild).not.toHaveBeenCalled();
    });
  }
);
