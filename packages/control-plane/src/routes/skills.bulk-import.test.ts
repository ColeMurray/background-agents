import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkSkillImportPreviewResponseSchema,
  MAX_BULK_SKILL_IMPORT_SKILLS,
  type BulkSkillImportPreviewResponse,
} from "@open-inspect/shared/types/skills";
import type * as AuthenticateModule from "../auth/authenticate";
import { SkillValidationError } from "../db/skills";
import type * as SourceControlModule from "../source-control";
import type { RepositoryTreeEntry } from "../source-control";
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
  unavailableNames: vi.fn(),
  createImportedSkills: vi.fn(),
  resolveCommit: vi.fn(),
  listTree: vi.fn(),
  readBlob: vi.fn<(input: { blobId: string }) => Promise<Uint8Array>>(),
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: async () => ({
      repoOwner: "acme",
      repoName: "skills",
      repoId: 1,
      defaultBranch: "main",
    }),
    resolveCommit: mocks.resolveCommit,
    listTree: mocks.listTree,
    readBlob: mocks.readBlob,
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
const reviewedCommit = "a".repeat(40);
const movedCommit = "f".repeat(40);

/** One skill root: its SKILL.md plus `references` supporting files. */
function skillFiles(root: string, name: string, references = 0): Record<string, string> {
  const files: Record<string, string> = {
    [`catalog/${root}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`,
  };
  for (let index = 0; index < references; index++) {
    files[`catalog/${root}/references/${index}.md`] = `${name} reference ${index}`;
  }
  return files;
}

/** Serve `files` as the tree the requested ref resolves to; blob IDs are paths. */
function serveRepository(
  commitSha: string,
  files: Record<string, string>,
  otherEntries: string[] = []
): void {
  const encoder = new TextEncoder();
  const entries: RepositoryTreeEntry[] = Object.entries(files).map(([path, content]) => ({
    path,
    type: "file",
    blobId: path,
    sizeBytes: encoder.encode(content).byteLength,
    executable: false,
  }));
  for (const path of otherEntries) {
    entries.push({ path, type: "other", blobId: path, sizeBytes: null, executable: false });
  }
  mocks.resolveCommit.mockResolvedValue({ sha: commitSha });
  mocks.listTree.mockResolvedValue({ entries, truncated: false });
  mocks.readBlob.mockImplementation(async ({ blobId }) => encoder.encode(files[blobId]));
}

function post(path: string, body: unknown): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, { method: "POST", body: JSON.stringify(body) }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

/** Preview the served collection, then forget its repository reads. */
async function preview(): Promise<BulkSkillImportPreviewResponse> {
  const response = await post("/skills/import/bulk/preview", { source: sourceInput });
  expect(response.status).toBe(200);
  const reviewed = bulkSkillImportPreviewResponseSchema.parse(await response.json());
  vi.clearAllMocks();
  return reviewed;
}

function confirmation(reviewed: BulkSkillImportPreviewResponse, names: readonly string[]) {
  return {
    source: sourceInput,
    expectedCommitSha: reviewed.commitSha,
    skills: reviewed.skills
      .filter((skill) => names.includes(skill.name))
      .map((skill) => ({
        subdirectory: skill.source.subdirectory,
        name: skill.name,
        expectedSourceSha256: skill.source.sourceSha256,
        expectedRevisionSha256: skill.revisionSha256,
      })),
  };
}

function readPaths(): string[] {
  return mocks.readBlob.mock.calls.map(([{ blobId }]) => blobId).sort();
}

describe("bulk managed skill import routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mocks.unavailableNames.mockResolvedValue(new Set());
    mocks.createImportedSkills.mockImplementation(async (inputs: { name: string }[]) =>
      inputs.map((input, index) => ({
        id: `skill_${index}`,
        name: input.name,
        currentRevisionId: `skillrev_${index}`,
      }))
    );
  });

  it("marks existing, reserved, and every duplicate collection name unavailable", async () => {
    serveRepository(reviewedCommit, {
      ...skillFiles("a", "duplicate"),
      ...skillFiles("b", "duplicate"),
      ...skillFiles("c", "existing"),
      ...skillFiles("d", "agent-browser"),
      ...skillFiles("e", "free"),
    });
    mocks.unavailableNames.mockResolvedValue(new Set(["existing", "agent-browser"]));

    const response = await post("/skills/import/bulk/preview", { source: sourceInput });
    const body = bulkSkillImportPreviewResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.commitSha).toBe(reviewedCommit);
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
    ["root", { subdirectory: "catalog/missing" }, /no longer in the collection/],
    ["name", { name: "renamed" }, /now named one/],
    ["source digest", { expectedSourceSha256: "f".repeat(64) }, /source content changed/],
    ["revision digest", { expectedRevisionSha256: "f".repeat(64) }, /imported skill changed/],
  ] as const)("rejects %s drift without writing", async (_case, override, message) => {
    serveRepository(reviewedCommit, skillFiles("one", "one"));
    const body = confirmation(await preview(), ["one"]);

    const response = await post("/skills/import/bulk", {
      ...body,
      skills: [{ ...body.skills[0], ...override }],
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual({
      error: expect.stringMatching(message),
    });
    expect(mocks.createImportedSkills).not.toHaveBeenCalled();
  });

  it("refuses a moved source with 409 before listing or reading it", async () => {
    serveRepository(reviewedCommit, { ...skillFiles("one", "one"), ...skillFiles("two", "two") });
    const body = confirmation(await preview(), ["one"]);
    mocks.resolveCommit.mockResolvedValue({ sha: movedCommit });

    const response = await post("/skills/import/bulk", body);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `The source moved to commit ${movedCommit} since it was previewed. Preview the import again.`,
    });
    expect(mocks.resolveCommit).toHaveBeenCalledOnce();
    expect(mocks.listTree).not.toHaveBeenCalled();
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(mocks.createImportedSkills).not.toHaveBeenCalled();
  });

  it.each([
    [
      "more skills than the collection limit",
      () =>
        serveRepository(
          movedCommit,
          Object.assign(
            {},
            ...Array.from({ length: MAX_BULK_SKILL_IMPORT_SKILLS + 1 }, (_, index) =>
              skillFiles(`skill-${index}`, `skill-${index}`)
            )
          )
        ),
    ],
    [
      "a nested skill root",
      () =>
        serveRepository(movedCommit, {
          ...skillFiles("one", "one"),
          ...skillFiles("one/child", "child"),
        }),
    ],
    [
      "an unselected skill that cannot be imported",
      () =>
        serveRepository(movedCommit, { ...skillFiles("one", "one"), ...skillFiles("two", "two") }, [
          "catalog/two/link",
        ]),
    ],
  ])("answers 409, not 400, when the moved tree has %s", async (_case, moveTree) => {
    serveRepository(reviewedCommit, { ...skillFiles("one", "one"), ...skillFiles("two", "two") });
    const body = confirmation(await preview(), ["one"]);
    moveTree();

    const response = await post("/skills/import/bulk", body);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/source moved/);
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(mocks.createImportedSkills).not.toHaveBeenCalled();
  });

  it("reads only the selected roots and persists them with shared assignments", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `skill-${index}`);
    serveRepository(
      reviewedCommit,
      Object.assign({}, ...names.map((name) => skillFiles(name, name, 2)))
    );
    const reviewed = await preview();
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await post("/skills/import/bulk", {
      ...confirmation(reviewed, ["skill-3", "skill-7"]),
      assignments: [{ type: "global" }],
    });

    expect(response.status).toBe(201);
    expect(mocks.listTree).toHaveBeenCalledOnce();
    expect(readPaths()).toEqual([
      "catalog/skill-3/SKILL.md",
      "catalog/skill-3/references/0.md",
      "catalog/skill-3/references/1.md",
      "catalog/skill-7/SKILL.md",
      "catalog/skill-7/references/0.md",
      "catalog/skill-7/references/1.md",
    ]);
    expect(mocks.createImportedSkills).toHaveBeenCalledOnce();
    const [inputs, assignments, actor] = mocks.createImportedSkills.mock.calls[0];
    expect(inputs.map((input: { name: string }) => input.name)).toEqual(["skill-3", "skill-7"]);
    expect(inputs[0].source).toMatchObject({
      commitSha: reviewedCommit,
      subdirectory: "catalog/skill-3",
    });
    expect(assignments).toEqual([{ type: "global" }]);
    expect(actor).toBe("user-1");
    const auditEvents = info.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event?: string; action?: string })
      .filter((event) => event.event === "managed_skills.audit");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.every((event) => event.action === "skill.imported")).toBe(true);
  });

  it("returns a validation response when an assigned environment disappears before the write", async () => {
    serveRepository(reviewedCommit, skillFiles("one", "one"));
    const body = confirmation(await preview(), ["one"]);
    mocks.createImportedSkills.mockRejectedValue(
      new SkillValidationError("One or more assigned environments no longer exist")
    );

    const response = await post("/skills/import/bulk", {
      ...body,
      assignments: [{ type: "environment", environmentId: "env-deleted" }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "One or more assigned environments no longer exist",
    });
  });
});
