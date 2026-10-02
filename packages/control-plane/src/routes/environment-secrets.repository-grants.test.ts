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
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type * as SourceControlModule from "../source-control";
import type { Env } from "../types";
import { environmentSecretsRoutes } from "./environment-secrets";

const mocks = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  scheduleImageBuildOnSave: vi.fn(),
  supersedeImageBuildsForSecretsChange: vi.fn(),
}));
vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: mocks.checkRepositoryAccess,
  }),
}));
vi.mock("../image-builds/save-hooks", () => ({
  scheduleImageBuildOnSave: mocks.scheduleImageBuildOnSave,
  supersedeImageBuildsForSecretsChange: mocks.supersedeImageBuildsForSecretsChange,
}));

const env = () => createRepositoryGrantEnv(["environments.secrets.manage", "environments.manage"]);
const request = createRepositoryGrantRequest(environmentSecretsRoutes, env);
const path = "/environments/env-1/secrets/import";
const body = { repoOwner: "acme", repoName: "repo" };
const destination = {
  id: "env-1",
  owner_team_id: "owner-team",
  name: "Environment",
  description: null,
  prebuild_enabled: 0,
  channel_associations: null,
  created_at: 1,
  updated_at: 1,
};
const sourceRepository = {
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
  vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
    new Map([["owner-team", "member"]])
  );
  mocks.checkRepositoryAccess.mockResolvedValue({
    repoId: 123,
    repoOwner: "acme",
    repoName: "repo",
    defaultBranch: "main",
  });
  mocks.supersedeImageBuildsForSecretsChange.mockResolvedValue(undefined);
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(destination);
  vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue([
    sourceRepository,
  ]);
  vi.spyOn(EnvironmentSecretsStore.prototype, "importFromRepo").mockResolvedValue({
    keys: ["KEY"],
    created: 1,
    updated: 0,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("environment secret import source grants", () => {
  it.each([null, "owner-team"] as const)(
    "denies a granted source without a granting-team lead (destination owner %s)",
    async (ownerTeamId) => {
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        ...destination,
        owner_team_id: ownerTeamId,
        prebuild_enabled: 1,
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        ownerTeamId === null ? new Map([["team-1", "lead"]]) : new Map([["owner-team", "member"]])
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
        async (teamId) =>
          teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "other-team",
        "owner-team",
      ]);

      const response = await request(path, "POST", body);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Repository grant required",
        code: "repository_grant_required",
        reason_code: "repository_grant_required",
        repository: "acme/repo",
      });
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
      expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
      expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
    }
  );

  it("denies an ungranted member source even when the source belongs to the environment", async () => {
    expect((await request(path, "POST", body)).status).toBe(409);
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
    expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
    expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
  });

  it("uses the current team's grant, not another caller team's grant", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([
        ["team-1", "member"],
        ["owner-team", "lead"],
      ])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(async (teamId) =>
      teamId === "team-1" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
    );
    expect((await request(path, "POST", body)).status).toBe(409);
    expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
  });

  it("checks membership before repository resolution", async () => {
    expect((await request(path, "POST", { repoOwner: "acme", repoName: "other" })).status).toBe(
      403
    );
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it.each([123, null])(
    "allows any source granting-team lead with only environments.secrets.manage (%s)",
    async (repoId) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([
          ["owner-team", "member"],
          ["other-team", "lead"],
        ])
      );
      vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
        { ...sourceRepository, repo_id: repoId },
      ]);
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
        async (teamId) =>
          teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "owner-team",
        "other-team",
      ]);
      const environment = env();
      environment.DB = authorizationDatabase({
        permissions: ["environments.secrets.manage", "environments.manage"],
      });
      expect((await request(path, "POST", body, environment)).status).toBe(200);
      expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
        "env-1",
        123,
        undefined
      );
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
    }
  );

  it("does not grant import access based on a matching repository name with a different ID", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 456 },
    ]);
    expect((await request(path, "POST", body)).status).toBe(409);
    expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
  });
});

describe.each(["off", "shadow", "on"] as const)(
  "environment secret source identity in %s mode",
  (mode) => {
    let environment: Env;
    beforeEach(() => {
      environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        ...destination,
        prebuild_enabled: 1,
      });
    });

    it.each([
      ["custom", 123],
      ["custom", 456],
      ["owner", 123],
      ["owner", 456],
      ["administrator", 123],
      ["administrator", 456],
    ] as const)(
      "rejects stored ID 123 resolving to 456 for %s with a grant for %s",
      async (role, grantedRepoId) => {
        if (role !== "custom") {
          vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
            userId: "user-1",
            suspendedAt: null,
            role: { ...BUILT_IN_ROLE_REGISTRY[role], name: role },
          });
        }
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          role === "custom" ? new Map([["owner-team", "lead"]]) : new Map()
        );
        vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
          { grant_kind: "repository", repo_external_id: grantedRepoId },
        ]);
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
          "owner-team",
        ]);
        mocks.checkRepositoryAccess.mockResolvedValue({
          repoId: 456,
          repoOwner: "acme",
          repoName: "repo",
          defaultBranch: "main",
        });

        const response = await request(path, "POST", body, environment);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          code: "repository_identity_mismatch",
          repository: "acme/repo",
        });
        expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
        expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
        expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
        expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
        expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
      }
    );

    it.each(["custom", "owner", "administrator"] as const)(
      "rejects a stale ID in a workspace-owned environment for %s without team membership",
      async (role) => {
        if (role !== "custom") {
          vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
            userId: "user-1",
            suspendedAt: null,
            role: { ...BUILT_IN_ROLE_REGISTRY[role], name: role },
          });
        }
        vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
          ...destination,
          owner_team_id: null,
          prebuild_enabled: 1,
        });
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        mocks.checkRepositoryAccess.mockResolvedValue({
          repoId: 456,
          repoOwner: "acme",
          repoName: "repo",
          defaultBranch: "main",
        });

        const response = await request(path, "POST", body, environment);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          code: "repository_identity_mismatch",
          repository: "acme/repo",
        });
        expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
        expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
        expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
        expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
        expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
        expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
      }
    );

    it.each([123, null])(
      "returns 404 when the member repository disappears (persisted ID %s)",
      async (repoId) => {
        vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
          { ...sourceRepository, repo_id: repoId },
        ]);
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          new Map([["owner-team", "lead"]])
        );
        vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
          { grant_kind: "repository", repo_external_id: 123 },
        ]);
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
          "owner-team",
        ]);
        mocks.checkRepositoryAccess.mockResolvedValue(null);

        const response = await request(path, "POST", body, environment);

        expect(response.status).toBe(404);
        expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
        expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
        expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
        expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
        expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
      }
    );

    it.each([
      { persistedRepoId: 123, resolvedRepoId: 123 },
      { persistedRepoId: null, resolvedRepoId: 456 },
    ])(
      "copies freshly resolved ID $resolvedRepoId after grants (persisted ID $persistedRepoId)",
      async ({ persistedRepoId, resolvedRepoId }) => {
        vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
          { ...sourceRepository, repo_id: persistedRepoId },
        ]);
        mocks.checkRepositoryAccess.mockResolvedValue({
          repoId: resolvedRepoId,
          repoOwner: "acme",
          repoName: "repo",
          defaultBranch: "main",
        });
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          new Map([["owner-team", "lead"]])
        );
        vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
          async (teamId) => {
            expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
            return teamId === "owner-team"
              ? [{ grant_kind: "repository", repo_external_id: resolvedRepoId }]
              : [];
          }
        );
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
          "owner-team",
        ]);

        expect((await request(path, "POST", body, environment)).status).toBe(200);
        expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
        expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(
          resolvedRepoId
        );
        expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
          "env-1",
          resolvedRepoId,
          undefined
        );
        expect(mocks.supersedeImageBuildsForSecretsChange).toHaveBeenCalledOnce();
        expect(mocks.scheduleImageBuildOnSave).toHaveBeenCalledOnce();
      }
    );
  }
);

describe.each(["off", "shadow", "on"] as const)(
  "workspace environment secret ownership in %s mode",
  (mode) => {
    it("preserves workspace-owned import with only its existing custom-role permission", async () => {
      const environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
      environment.DB = authorizationDatabase({
        permissions: ["environments.secrets.manage", "environments.manage"],
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        ...destination,
        owner_team_id: null,
      });

      expect((await request(path, "POST", body, environment)).status).toBe(200);
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
    });
  }
);

describe.each(["owner", "administrator"] as const)(
  "built-in %s environment secret authorization",
  (key) => {
    beforeEach(() => {
      vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
        userId: "user-1",
        suspendedAt: null,
        role: { ...BUILT_IN_ROLE_REGISTRY[key], name: key },
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    });

    it("allows environment secret import from another team's source without lead membership", async () => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
        async (teamId) =>
          teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
      );

      expect((await request(path, "POST", body)).status).toBe(200);
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
      expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
        "env-1",
        123,
        undefined
      );
    });

    it("cannot import source secrets without the destination team's covering grant", async () => {
      const response = await request(path, "POST", body);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Target team lacks repository grant",
        code: "target_team_missing_grant",
        repository: "acme/repo",
      });
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
      expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
      expect(mocks.supersedeImageBuildsForSecretsChange).not.toHaveBeenCalled();
      expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
    });
  }
);
