import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import {
  skillImportPreviewResponseSchema,
  skillSchema,
  type SkillAssignmentInput,
} from "@open-inspect/shared/types/skills";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as SourceControlModule from "../source-control";
import { AuthorizationStore } from "../db/authorization-store";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { SkillStore, SkillValidationError } from "../db/skills";
import { SourceControlProviderError } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoMetadataStore } from "../db/repo-metadata";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { skillRoutes } from "./skills";
import { secretsRoutes } from "./secrets";
import { environmentSecretsRoutes } from "./environment-secrets";
import { imageBuildRoutes } from "./image-builds";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  checkRepositoryAccess: vi.fn(),
  resolveCommit: vi.fn(),
  listTree: vi.fn(),
  readBlob: vi.fn(),
  triggerBuild: vi.fn(),
  scheduleImageBuildOnSave: vi.fn(),
  supersedeImageBuildsForSecretsChange: vi.fn(),
}));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: mocks.checkRepositoryAccess,
    resolveCommit: mocks.resolveCommit,
    listTree: mocks.listTree,
    readBlob: mocks.readBlob,
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
  supersedeImageBuildsForSecretsChange: mocks.supersedeImageBuildsForSecretsChange,
}));

const handleRequest = createTestRequestHandler([
  skillRoutes,
  secretsRoutes,
  environmentSecretsRoutes,
  imageBuildRoutes,
]);
const content = { description: "Deploy a service", body: "# Deploy", metadata: {}, files: [] };
const source = {
  provider: "github",
  repoOwner: "acme",
  repoName: "repo",
  requestedRef: null,
  resolvedRef: "main",
  commitSha: "a".repeat(40),
  subdirectory: null,
  sourceSha256: "b".repeat(64),
  importedAt: 1,
  revisionId: "revision-1",
};
const skill = skillSchema.parse({
  id: "skill-1",
  name: "deploy",
  ...content,
  enabled: true,
  currentRevisionId: "revision-1",
  revisionNumber: 1,
  revisionSha256: "c".repeat(64),
  revisionCreatedBy: "user-1",
  creatorDisplayName: null,
  lastEditorDisplayName: null,
  revisionAuthorDisplayName: null,
  assignments: [],
  source,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
  license: null,
  compatibility: null,
});
const importSource = { repository: { repoOwner: "acme", repoName: "repo" } };
const confirmation = {
  expectedCommitSha: "a".repeat(40),
  expectedSourceSha256: "b".repeat(64),
  expectedRevisionSha256: "c".repeat(64),
};
const assignment: SkillAssignmentInput = {
  type: "repository",
  repository: { repoOwner: "acme", repoName: "repo", baseBranch: null },
};
const skillAssignmentWrites = [
  ["POST", "/skills", { name: "deploy", content, assignments: [assignment] }, 201],
  ["PUT", "/skills/skill-1", { content, assignments: [assignment] }, 200],
] as const;
const repositorySecretRequests = [
  ["GET", "/repos/acme/repo/secrets", undefined],
  ["PUT", "/repos/acme/repo/secrets", { secrets: { KEY: "value" } }],
  ["DELETE", "/repos/acme/repo/secrets/KEY", undefined],
] as const;
const repositoryImageWrites = [
  ["POST", "/image-builds/trigger/repo/acme/repo", undefined],
  ["PUT", "/image-builds/toggle/repo/acme/repo", { enabled: true }],
] as const;

function env(): Env {
  return createTestEnv({
    DB: authorizationDatabase({
      permissions: [
        "skills.manage",
        "repositories.secrets.manage",
        "environments.secrets.manage",
        "repositories.images.manage",
        "environments.images.manage",
      ],
    }),
    SCM_PROVIDER: "github",
    SANDBOX_PROVIDER: "modal",
    TEAMS_ENFORCEMENT: "on",
    REPO_SECRETS_ENCRYPTION_KEY: "test-key",
  });
}

function request(
  path: string,
  method: string,
  body?: unknown,
  environment = env()
): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: { "Content-Type": "application/json", "If-Match": "revision-1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    environment,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

async function expectAllowedSkillImports(environment = env()): Promise<void> {
  const preview = await request(
    "/skills/import/preview",
    "POST",
    { source: importSource },
    environment
  );
  expect(preview.status).toBe(200);
  const imported = skillImportPreviewResponseSchema.parse(await preview.json());
  const currentConfirmation = {
    expectedCommitSha: imported.source.commitSha,
    expectedSourceSha256: imported.source.sourceSha256,
    expectedRevisionSha256: imported.revisionSha256,
  };
  expect(
    (
      await request(
        "/skills/import",
        "POST",
        { source: importSource, assignments: [assignment], ...currentConfirmation },
        environment
      )
    ).status
  ).toBe(201);
  const reimportPreview = await request(
    "/skills/skill-1/reimport/preview",
    "POST",
    {},
    environment
  );
  expect(reimportPreview.status).toBe(200);
  const reimported = skillImportPreviewResponseSchema.parse(await reimportPreview.json());
  expect(
    (
      await request(
        "/skills/skill-1/reimport",
        "POST",
        {
          expectedCommitSha: reimported.source.commitSha,
          expectedSourceSha256: reimported.source.sourceSha256,
          expectedRevisionSha256: reimported.revisionSha256,
        },
        environment
      )
    ).status
  ).toBe(200);
  expect(SkillStore.prototype.create).toHaveBeenCalledOnce();
  expect(SkillStore.prototype.applyImportedRevision).toHaveBeenCalledOnce();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "user", userId: "user-1" },
    request,
  }));
  mocks.checkRepositoryAccess.mockResolvedValue({
    repoId: 123,
    repoOwner: "acme",
    repoName: "repo",
    defaultBranch: "main",
  });
  mocks.resolveCommit.mockResolvedValue({ sha: "a".repeat(40) });
  mocks.listTree.mockResolvedValue({
    entries: [
      {
        path: "SKILL.md",
        type: "file",
        blobId: "blob",
        sizeBytes: 50,
        executable: false,
      },
    ],
    truncated: false,
  });
  mocks.readBlob.mockResolvedValue(
    new TextEncoder().encode("---\nname: deploy\ndescription: Deploy a service\n---\n# Deploy\n")
  );
  mocks.triggerBuild.mockResolvedValue({ type: "building", buildId: "build-1" });
  mocks.supersedeImageBuildsForSecretsChange.mockResolvedValue(undefined);
  vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockResolvedValue(
    new Map([["team-1", "member"]])
  );
  vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository").mockResolvedValue([
    "other-team",
  ]);
  vi.spyOn(SkillStore.prototype, "create").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "get").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "replaceContentAndAssignments").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "applyImportedRevision").mockResolvedValue({
    skill,
    revisionCreated: true,
  });
  vi.spyOn(SkillStore.prototype, "nameAvailable").mockResolvedValue(true);
  vi.spyOn(RepoSecretsStore.prototype, "setSecrets").mockResolvedValue({
    keys: ["KEY"],
    created: 1,
    updated: 0,
  });
  vi.spyOn(RepoSecretsStore.prototype, "listSecretKeys").mockResolvedValue([]);
  vi.spyOn(RepoSecretsStore.prototype, "deleteSecret").mockResolvedValue(true);
  vi.spyOn(GlobalSecretsStore.prototype, "listSecretKeys").mockResolvedValue([]);
  vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue({
    id: "env-1",
    owner_team_id: "owner-team",
    name: "Environment",
    description: null,
    prebuild_enabled: 0,
    channel_associations: null,
    created_at: 1,
    updated_at: 1,
  });
  vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue([
    {
      environment_id: "env-1",
      position: 0,
      repo_owner: "acme",
      repo_name: "repo",
      repo_id: 123,
      base_branch: "main",
    },
  ]);
  vi.spyOn(EnvironmentSecretsStore.prototype, "importFromRepo").mockResolvedValue({
    keys: ["KEY"],
    created: 1,
    updated: 0,
  });
  vi.spyOn(RepoMetadataStore.prototype, "setImageBuildEnabled").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("skill repository-bearing writes", () => {
  it.each(skillAssignmentWrites)(
    "denies %s %s with another team's assignment before persistence",
    async (method, path, body) => {
      expect((await request(path, method, body)).status).toBe(403);
      expect(SkillStore.prototype.create).not.toHaveBeenCalled();
      expect(SkillStore.prototype.replaceContentAndAssignments).not.toHaveBeenCalled();
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
    }
  );

  it.each([
    ["/skills/import/preview", { source: importSource }],
    ["/skills/import", { source: importSource, ...confirmation }],
    ["/skills/skill-1/reimport/preview", {}],
    ["/skills/skill-1/reimport", confirmation],
  ])("denies source access at %s before reading repository content", async (path, body) => {
    expect((await request(path, "POST", body)).status).toBe(403);
    expect(mocks.resolveCommit).not.toHaveBeenCalled();
    expect(mocks.listTree).not.toHaveBeenCalled();
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(SkillStore.prototype.create).not.toHaveBeenCalled();
    expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
  });

  it.each(skillAssignmentWrites)(
    "allows %s %s for an owning-team member with skills.manage alone",
    async (method, path, body, status) => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "other-team",
        "team-1",
      ]);
      expect((await request(path, method, body)).status).toBe(status);
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    }
  );

  it("resolves assignments sequentially", async () => {
    let activeLookups = 0;
    let peakLookups = 0;
    mocks.checkRepositoryAccess.mockImplementation(
      async ({ owner, name }: { owner: string; name: string }) => {
        activeLookups++;
        peakLookups = Math.max(peakLookups, activeLookups);
        await Promise.resolve();
        activeLookups--;
        return {
          repoId: name === "other" ? 456 : 123,
          repoOwner: owner,
          repoName: name,
          defaultBranch: "main",
        };
      }
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);
    const response = await request("/skills", "POST", {
      name: "deploy",
      content,
      assignments: [
        assignment,
        { type: "repository", repository: { repoOwner: "acme", repoName: "other" } },
      ],
    });

    expect(response.status).toBe(201);
    expect(peakLookups).toBe(1);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledTimes(2);
  });

  it("resolves duplicate repositories once without removing assignments from store validation", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);
    vi.mocked(SkillStore.prototype.create).mockRejectedValue(
      new SkillValidationError("Skill assignments must be unique")
    );
    const assignments = [assignment, assignment];

    expect(
      (await request("/skills", "POST", { name: "deploy", content, assignments })).status
    ).toBe(400);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(SkillStore.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignments }),
      "user-1"
    );
  });

  it.each([
    { failure: new SourceControlProviderError("SCM unavailable", "transient", 503), status: 503 },
    {
      failure: new SourceControlProviderError("SCM rejected access", "permanent", 401),
      status: 502,
    },
  ])(
    "preserves importer resolution errors ($status) before grants and content reads",
    async ({ failure, status }) => {
      mocks.checkRepositoryAccess.mockRejectedValue(failure);
      for (const [path, body] of [
        ["/skills/import/preview", { source: importSource }],
        ["/skills/import", { source: importSource, ...confirmation }],
        ["/skills/skill-1/reimport/preview", {}],
        ["/skills/skill-1/reimport", confirmation],
      ] as const) {
        const response = await request(path, "POST", body);
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toEqual({
          error: `Failed to reach acme/repo: ${failure.message}`,
        });
      }
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
      expect(mocks.resolveCommit).not.toHaveBeenCalled();
      expect(mocks.readBlob).not.toHaveBeenCalled();
      expect(SkillStore.prototype.create).not.toHaveBeenCalled();
      expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
    }
  );

  it("preserves the importer-specific inaccessible repository response", async () => {
    mocks.checkRepositoryAccess.mockResolvedValue(null);
    const response = await request("/skills/import/preview", "POST", { source: importSource });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error:
        "acme/repo is not accessible to this installation. Grant the app access to the repository and try again.",
    });
    expect(mocks.readBlob).not.toHaveBeenCalled();
  });

  it("rejects an uninstalled assignment before persistence even with an installation grant", async () => {
    mocks.checkRepositoryAccess.mockResolvedValue(null);
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);
    expect(
      (await request("/skills", "POST", { name: "deploy", content, assignments: [assignment] }))
        .status
    ).toBe(404);
    expect(SkillStore.prototype.create).not.toHaveBeenCalled();
  });

  it("rejects a replaced numeric source ID rather than trusting recorded provenance names", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockImplementation(
      async (repoId) => (repoId === 456 ? ["team-1"] : ["other-team"])
    );
    expect((await request("/skills/skill-1/reimport", "POST", confirmation)).status).toBe(403);
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledWith({ owner: "acme", name: "repo" });
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
  });

  it("checks import assignments independently of a granted source", async () => {
    mocks.checkRepositoryAccess.mockImplementation(
      async ({ owner, name }: { owner: string; name: string }) => ({
        repoId: name === "source" ? 456 : 123,
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
      })
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockImplementation(
      async (repoId) => (repoId === 456 ? ["team-1"] : ["other-team"])
    );
    expect(
      (
        await request("/skills/import", "POST", {
          source: { repository: { repoOwner: "acme", repoName: "source" } },
          assignments: [assignment],
          ...confirmation,
        })
      ).status
    ).toBe(403);
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(SkillStore.prototype.create).not.toHaveBeenCalled();
  });

  it("allows an owning-team member to preview and confirm import and reimport", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-1",
    ]);
    await expectAllowedSkillImports();
    expect(mocks.checkRepositoryAccess).toHaveBeenCalledTimes(5);
  });
});

describe("repository secret source grants", () => {
  it.each(repositorySecretRequests)(
    "denies %s source access for a granted member who is not a lead",
    async (method, path, body) => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "team-1",
      ]);
      expect((await request(path, method, body)).status).toBe(403);
      expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
      expect(RepoSecretsStore.prototype.setSecrets).not.toHaveBeenCalled();
      expect(RepoSecretsStore.prototype.deleteSecret).not.toHaveBeenCalled();
    }
  );

  it("denies an active lead without a covering source grant", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["team-1", "lead"]])
    );
    expect((await request("/repos/acme/repo/secrets", "GET")).status).toBe(403);
    expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
  });

  it.each(repositorySecretRequests)(
    "allows %s for an owning-team lead without adding repositories.use",
    async (method, path, body) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([["team-1", "lead"]])
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "other-team",
        "team-1",
      ]);
      expect((await request(path, method, body)).status).toBe(200);
    }
  );

  it("retains repositories.secrets.manage admission before grants", async () => {
    const environment = env();
    environment.DB = authorizationDatabase({ permissions: [] });
    expect((await request("/repos/acme/repo/secrets", "GET", undefined, environment)).status).toBe(
      403
    );
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
  });
});

describe("environment secret import source grants", () => {
  const path = "/environments/env-1/secrets/import";
  const body = { repoOwner: "acme", repoName: "repo" };
  it.each([null, "owner-team"] as const)(
    "denies a granted source without a granting-team lead (destination owner %s)",
    async (ownerTeamId) => {
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
        id: "env-1",
        owner_team_id: ownerTeamId,
        name: "Environment",
        description: null,
        prebuild_enabled: 1,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
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
        {
          environment_id: "env-1",
          position: 0,
          repo_owner: "acme",
          repo_name: "repo",
          repo_id: repoId,
          base_branch: "main",
        },
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
      environment.DB = authorizationDatabase({ permissions: ["environments.secrets.manage"] });
      expect((await request(path, "POST", body, environment)).status).toBe(200);
      expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
        "env-1",
        123,
        undefined
      );
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      expect(mocks.checkRepositoryAccess).toHaveBeenCalledTimes(repoId === null ? 1 : 0);
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
      id: "env-1",
      owner_team_id: null,
      name: "Environment",
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    });
    expect((await request("/image-builds/trigger/environment/env-1", "POST")).status).toBe(200);
    expect(mocks.triggerBuild).toHaveBeenCalledOnce();
  });

  it("checks every current repository against the environment owner regardless of persisted IDs", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["owner-team", "member"]])
    );
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
      {
        environment_id: "env-1",
        position: 0,
        repo_owner: "acme",
        repo_name: "repo",
        repo_id: 123,
        base_branch: "main",
      },
      {
        environment_id: "env-1",
        position: 1,
        repo_owner: "acme",
        repo_name: "other",
        repo_id: null,
        base_branch: "main",
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
  "workspace repository ownership in %s mode",
  (mode) => {
    let environment: Env;
    beforeEach(() => {
      environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
    });

    it.each(skillAssignmentWrites)(
      "allows %s %s with no grants anywhere and only existing permissions",
      async (method, path, body, status) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        expect((await request(path, method, body, environment)).status).toBe(status);
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      }
    );

    it("allows import and reimport preview confirmation with no grants anywhere", async () => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
      await expectAllowedSkillImports(environment);
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
    });

    it.each(repositorySecretRequests)(
      "allows secret %s with no grants anywhere and only existing permissions",
      async (method, path, body) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        expect((await request(path, method, body, environment)).status).toBe(200);
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      }
    );

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
      "denies another team's repositories for an unrelated %s across workspace routes",
      async (role) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          role === null ? new Map() : new Map([["team-1", role]])
        );
        for (const [method, path, body] of [
          ...skillAssignmentWrites,
          ...repositorySecretRequests,
          ...repositoryImageWrites,
          ["POST", "/skills/import/preview", { source: importSource }],
          ["POST", "/skills/import", { source: importSource, ...confirmation }],
          ["POST", "/skills/skill-1/reimport/preview", {}],
          ["POST", "/skills/skill-1/reimport", confirmation],
        ] as const) {
          expect((await request(path, method, body, environment)).status).toBe(403);
        }
        expect(SkillStore.prototype.create).not.toHaveBeenCalled();
        expect(SkillStore.prototype.replaceContentAndAssignments).not.toHaveBeenCalled();
        expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
        expect(mocks.readBlob).not.toHaveBeenCalled();
        expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
        expect(RepoSecretsStore.prototype.setSecrets).not.toHaveBeenCalled();
        expect(RepoSecretsStore.prototype.deleteSecret).not.toHaveBeenCalled();
        expect(RepoMetadataStore.prototype.setImageBuildEnabled).not.toHaveBeenCalled();
        expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
        expect(mocks.triggerBuild).not.toHaveBeenCalled();
      }
    );

    it.each([
      ["/image-builds/trigger/environment/env-1", undefined, "environments.images.manage"],
      [
        "/environments/env-1/secrets/import",
        { repoOwner: "acme", repoName: "repo" },
        "environments.secrets.manage",
      ],
    ] as const)(
      "preserves workspace-owned %s with only its existing custom-role permission",
      async (path, body, permission) => {
        environment.DB = authorizationDatabase({ permissions: [permission] });
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
          id: "env-1",
          owner_team_id: null,
          name: "Environment",
          description: null,
          prebuild_enabled: 0,
          channel_associations: null,
          created_at: 1,
          updated_at: 1,
        });

        expect((await request(path, "POST", body, environment)).status).toBe(200);
        expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
        expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
        if (path === "/environments/env-1/secrets/import") {
          expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(
            123
          );
        } else {
          expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
        }
      }
    );
  }
);

describe.each(["owner", "administrator"] as const)(
  "built-in %s repository authorization",
  (key) => {
    beforeEach(() => {
      vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
        userId: "user-1",
        suspendedAt: null,
        role: { ...BUILT_IN_ROLE_REGISTRY[key], name: key },
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    });

    it.each(skillAssignmentWrites)(
      "allows %s %s for another team's repository without membership",
      async (method, path, body, status) => {
        expect((await request(path, method, body)).status).toBe(status);
      }
    );

    it("allows import and reimport preview confirmation for another team's repository", async () => {
      await expectAllowedSkillImports();
    });

    it.each(repositorySecretRequests)(
      "allows secret %s for another team's repository without lead membership",
      async (method, path, body) => {
        expect((await request(path, method, body)).status).toBe(200);
      }
    );

    it.each(repositoryImageWrites)(
      "allows image %s for another team's repository without membership",
      async (method, path, body) => {
        expect((await request(path, method, body)).status).toBe(200);
      }
    );

    it("allows environment secret import from another team's source without lead membership", async () => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockImplementation(
        async (teamId) =>
          teamId === "owner-team" ? [{ grant_kind: "repository", repo_external_id: 123 }] : []
      );

      expect(
        (
          await request("/environments/env-1/secrets/import", "POST", {
            repoOwner: "acme",
            repoName: "repo",
          })
        ).status
      ).toBe(200);
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
        "env-1",
        123,
        undefined
      );
    });

    it("cannot import source secrets without the destination team's covering grant", async () => {
      const response = await request("/environments/env-1/secrets/import", "POST", {
        repoOwner: "acme",
        repoName: "repo",
      });

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
