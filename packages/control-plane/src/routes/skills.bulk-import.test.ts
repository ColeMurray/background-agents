import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { SkillValidationError } from "../db/skills";
import type * as GitImportModule from "../skills/git-import";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchBulkSkillImport: vi.fn(),
  unavailableNames: vi.fn(),
  createImportedSkills: vi.fn(),
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../skills/git-import", async (importOriginal) => ({
  ...(await importOriginal<typeof GitImportModule>()),
  fetchBulkSkillImport: mocks.fetchBulkSkillImport,
  resolveSkillImportRepository: vi.fn().mockResolvedValue({
    repoOwner: "acme",
    repoName: "skills",
    repoId: 1,
    defaultBranch: "main",
  }),
}));

vi.mock("../db/skills", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  SkillStore: vi.fn().mockImplementation(function () {
    return {
      unavailableNames: mocks.unavailableNames,
      createImportedSkills: mocks.createImportedSkills,
    };
  }),
}));

const handleRequest = createTestRequestHandler([skillRoutes]);
const env = {
  ...TEST_SERVICE_SECRETS,
  SCM_PROVIDER: "github",
  DB: ownerAuthorizationDatabase(),
} as unknown as Env;

const sourceInput = {
  repository: { repoOwner: "acme", repoName: "skills" },
  ref: "main",
  subdirectory: "catalog",
};
const commitSha = "a".repeat(40);

function fetchedSkill(
  name: string,
  subdirectory: string,
  digest = name.charCodeAt(0).toString(16)
) {
  const sourceSha256 = digest.padEnd(64, "b").slice(0, 64);
  const revisionSha256 = digest.padEnd(64, "c").slice(0, 64);
  return {
    name,
    content: {
      description: `${name} description`,
      body: `${name} body`,
      license: null,
      compatibility: null,
      metadata: {},
      files: [],
    },
    source: {
      provider: "github" as const,
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "main",
      resolvedRef: "main",
      commitSha,
      subdirectory,
      sourceSha256,
    },
    warnings: [],
    revisionSha256,
    totalBytes: 20,
    files: [{ path: "SKILL.md", content: name, sizeBytes: name.length, executable: false }],
  };
}

function post(path: string, body: unknown): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, { method: "POST", body: JSON.stringify(body) }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("bulk managed skill import routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mocks.unavailableNames.mockResolvedValue(new Set());
  });

  it("marks existing, reserved, and every duplicate collection name unavailable", async () => {
    const skills = [
      fetchedSkill("duplicate", "catalog/a", "1"),
      fetchedSkill("duplicate", "catalog/b", "2"),
      fetchedSkill("existing", "catalog/c", "3"),
      fetchedSkill("agent-browser", "catalog/d", "4"),
      fetchedSkill("free", "catalog/e", "5"),
    ];
    mocks.fetchBulkSkillImport.mockResolvedValue({
      skills,
      commitSha,
      totalFiles: 5,
      totalBytes: 100,
    });
    mocks.unavailableNames.mockResolvedValue(new Set(["existing", "agent-browser"]));

    const response = await post("/skills/import/bulk/preview", { source: sourceInput });
    const body = (await response.json()) as { skills: { name: string; nameAvailable: boolean }[] };

    expect(response.status).toBe(200);
    expect(body.skills.map(({ name, nameAvailable }) => [name, nameAvailable])).toEqual([
      ["duplicate", false],
      ["duplicate", false],
      ["existing", false],
      ["agent-browser", false],
      ["free", true],
    ]);
    expect(mocks.unavailableNames).toHaveBeenCalledOnce();
    expect(mocks.unavailableNames).toHaveBeenCalledWith([
      "duplicate",
      "duplicate",
      "existing",
      "agent-browser",
      "free",
    ]);
  });

  it.each([
    ["commit", { expectedCommitSha: "f".repeat(40) }, /source moved/],
    [
      "root",
      { skill: { subdirectory: "catalog/missing", name: "one" } },
      /no longer in the collection/,
    ],
    ["name", { skill: { subdirectory: "catalog/one", name: "renamed" } }, /now named one/],
    [
      "source digest",
      { skill: { subdirectory: "catalog/one", expectedSourceSha256: "f".repeat(64) } },
      /source content changed/,
    ],
    [
      "revision digest",
      { skill: { subdirectory: "catalog/one", expectedRevisionSha256: "f".repeat(64) } },
      /imported skill changed/,
    ],
  ] as [
    string,
    {
      expectedCommitSha?: string;
      skill?: Partial<{
        subdirectory: string;
        name: string;
        expectedSourceSha256: string;
        expectedRevisionSha256: string;
      }>;
    },
    RegExp,
  ][])("rejects %s drift without writing", async (_case, override, message) => {
    const skill = fetchedSkill("one", "catalog/one", "1");
    mocks.fetchBulkSkillImport.mockResolvedValue({
      skills: [skill],
      commitSha,
      totalFiles: 1,
      totalBytes: 20,
    });
    const reviewed = {
      subdirectory: skill.source.subdirectory,
      name: skill.name,
      expectedSourceSha256: skill.source.sourceSha256,
      expectedRevisionSha256: skill.revisionSha256,
      ...override.skill,
    };

    const response = await post("/skills/import/bulk", {
      source: sourceInput,
      expectedCommitSha: override.expectedCommitSha ?? commitSha,
      skills: [reviewed],
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual({
      error: expect.stringMatching(message),
    });
    expect(mocks.fetchBulkSkillImport).toHaveBeenCalledTimes(1);
    expect(mocks.createImportedSkills).not.toHaveBeenCalled();
  });

  it("persists only selected reviewed roots with shared assignments and audits each skill", async () => {
    const selected = [
      fetchedSkill("one", "catalog/one", "1"),
      fetchedSkill("two", "catalog/two", "2"),
    ];
    const unselected = fetchedSkill("three", "catalog/three", "3");
    mocks.fetchBulkSkillImport.mockResolvedValue({
      skills: [...selected, unselected],
      commitSha,
      totalFiles: 3,
      totalBytes: 60,
    });
    const stored = selected.map((skill, index) => ({
      id: `skill_${index}`,
      name: skill.name,
      currentRevisionId: `skillrev_${index}`,
      source: { ...skill.source, importedAt: 1, revisionId: `skillrev_${index}` },
    }));
    mocks.createImportedSkills.mockResolvedValue(stored);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await post("/skills/import/bulk", {
      source: sourceInput,
      expectedCommitSha: commitSha,
      skills: selected.map((skill) => ({
        subdirectory: skill.source.subdirectory,
        name: skill.name,
        expectedSourceSha256: skill.source.sourceSha256,
        expectedRevisionSha256: skill.revisionSha256,
      })),
      assignments: [{ type: "global" }],
    });

    expect(response.status).toBe(201);
    expect(mocks.fetchBulkSkillImport).toHaveBeenCalledTimes(1);
    expect(mocks.createImportedSkills).toHaveBeenCalledWith(
      selected.map((skill) => ({ name: skill.name, content: skill.content, source: skill.source })),
      [{ type: "global" }],
      "user-1"
    );
    const auditEvents = info.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event?: string; action?: string })
      .filter((event) => event.event === "managed_skills.audit");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.every((event) => event.action === "skill.imported")).toBe(true);
  });

  it("returns a validation response when an assigned environment disappears before the write", async () => {
    const skill = fetchedSkill("one", "catalog/one", "1");
    mocks.fetchBulkSkillImport.mockResolvedValue({
      skills: [skill],
      commitSha,
      totalFiles: 1,
      totalBytes: 20,
    });
    mocks.createImportedSkills.mockRejectedValue(
      new SkillValidationError("One or more assigned environments no longer exist")
    );

    const response = await post("/skills/import/bulk", {
      source: sourceInput,
      expectedCommitSha: commitSha,
      skills: [
        {
          subdirectory: skill.source.subdirectory,
          name: skill.name,
          expectedSourceSha256: skill.source.sourceSha256,
          expectedRevisionSha256: skill.revisionSha256,
        },
      ],
      assignments: [{ type: "environment", environmentId: "env-deleted" }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "One or more assigned environments no longer exist",
    });
  });
});
