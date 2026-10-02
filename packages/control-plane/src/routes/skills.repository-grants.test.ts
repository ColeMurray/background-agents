import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import {
  skillImportPreviewResponseSchema,
  skillSchema,
  type SkillAssignmentInput,
} from "@open-inspect/shared/types/skills";
import {
  createRepositoryGrantEnv,
  createRepositoryGrantRequest,
  setupRepositoryGrantSpies,
} from "./repository-grants.test-support";
import { AuthorizationStore } from "../db/authorization-store";
import { SkillStore, SkillValidationError } from "../db/skills";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { SourceControlProviderError } from "../source-control";
import type * as SourceControlModule from "../source-control";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  resolveCommit: vi.fn(),
  listTree: vi.fn(),
  readBlob: vi.fn(),
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

const env = () => createRepositoryGrantEnv(["skills.manage"]);
const request = createRepositoryGrantRequest(skillRoutes, env);
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
const skillImportRequests = [
  ["/skills/import/preview", { source: importSource }],
  ["/skills/import", { source: importSource, ...confirmation }],
  ["/skills/skill-1/reimport/preview", {}],
  ["/skills/skill-1/reimport", confirmation],
] as const;

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
  setupRepositoryGrantSpies();
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
  vi.spyOn(SkillStore.prototype, "create").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "get").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "replaceContentAndAssignments").mockResolvedValue(skill);
  vi.spyOn(SkillStore.prototype, "applyImportedRevision").mockResolvedValue({
    skill,
    revisionCreated: true,
  });
  vi.spyOn(SkillStore.prototype, "nameAvailable").mockResolvedValue(true);
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

  it.each(skillImportRequests)(
    "denies source access at %s before reading repository content",
    async (path, body) => {
      expect((await request(path, "POST", body)).status).toBe(403);
      expect(mocks.resolveCommit).not.toHaveBeenCalled();
      expect(mocks.listTree).not.toHaveBeenCalled();
      expect(mocks.readBlob).not.toHaveBeenCalled();
      expect(SkillStore.prototype.create).not.toHaveBeenCalled();
      expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
    }
  );

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
      for (const [path, body] of skillImportRequests) {
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

describe.each(["off", "shadow", "on"] as const)(
  "workspace skill repository ownership in %s mode",
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

    it.each(["member", "lead", null] as const)(
      "denies another team's repositories for an unrelated %s across skill routes",
      async (role) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          role === null ? new Map() : new Map([["team-1", role]])
        );
        for (const [method, path, body] of skillAssignmentWrites) {
          expect((await request(path, method, body, environment)).status).toBe(403);
        }
        for (const [path, body] of skillImportRequests) {
          expect((await request(path, "POST", body, environment)).status).toBe(403);
        }
        expect(SkillStore.prototype.create).not.toHaveBeenCalled();
        expect(SkillStore.prototype.replaceContentAndAssignments).not.toHaveBeenCalled();
        expect(SkillStore.prototype.applyImportedRevision).not.toHaveBeenCalled();
        expect(mocks.readBlob).not.toHaveBeenCalled();
      }
    );
  }
);

describe.each(["owner", "administrator"] as const)(
  "built-in %s skill repository authorization",
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
  }
);
