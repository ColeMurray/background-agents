import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  skillImportPreviewResponseSchema,
  type SkillImportPreviewResponse,
} from "@open-inspect/shared/types/skills";
import type * as AuthenticateModule from "../auth/authenticate";
import { SkillConflictError } from "../db/skills";
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
  nameAvailable: vi.fn(),
  create: vi.fn(),
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
    return { nameAvailable: mocks.nameAvailable, create: mocks.create };
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
  subdirectory: "catalog/deploy",
};
const reviewedCommit = "a".repeat(40);
const movedCommit = "f".repeat(40);
const reviewedFiles = {
  "catalog/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys the API\n---\nbody\n",
  "catalog/deploy/references/guide.md": "guide",
};

/** Serve `files` as the tree the requested ref resolves to; blob IDs are paths. */
function serveRepository(commitSha: string, files: Record<string, string>): void {
  const encoder = new TextEncoder();
  const entries: RepositoryTreeEntry[] = Object.entries(files).map(([path, content]) => ({
    path,
    type: "file",
    blobId: path,
    sizeBytes: encoder.encode(content).byteLength,
    executable: false,
  }));
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

/** Preview the served skill, then forget its repository reads. */
async function preview(): Promise<SkillImportPreviewResponse> {
  const response = await post("/skills/import/preview", { source: sourceInput });
  expect(response.status).toBe(200);
  const reviewed = skillImportPreviewResponseSchema.parse(await response.json());
  vi.clearAllMocks();
  return reviewed;
}

function confirmation(reviewed: SkillImportPreviewResponse) {
  return {
    source: sourceInput,
    expectedCommitSha: reviewed.source.commitSha,
    expectedSourceSha256: reviewed.source.sourceSha256,
    expectedRevisionSha256: reviewed.revisionSha256,
  };
}

describe("single managed skill import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mocks.nameAvailable.mockResolvedValue(true);
    mocks.create.mockImplementation(async (input: { name: string }) => ({
      id: "skill_1",
      name: input.name,
      currentRevisionId: "skillrev_1",
    }));
  });

  it("refuses a moved source with 409 before listing or reading it", async () => {
    serveRepository(reviewedCommit, reviewedFiles);
    const body = confirmation(await preview());
    mocks.resolveCommit.mockResolvedValue({ sha: movedCommit });

    const response = await post("/skills/import", body);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `The source moved to commit ${movedCommit} since it was previewed. Preview the import again.`,
    });
    expect(mocks.resolveCommit).toHaveBeenCalledOnce();
    expect(mocks.listTree).not.toHaveBeenCalled();
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["404", "no longer has the reviewed skill", { "catalog/other/SKILL.md": "other" }],
    [
      "400",
      "has a SKILL.md that no longer maps",
      { "catalog/deploy/SKILL.md": "---\nname: deploy\n---\nbody\n" },
    ],
  ])("answers 409, not %s, when the moved commit %s", async (_status, _case, movedFiles) => {
    serveRepository(reviewedCommit, reviewedFiles);
    const body = confirmation(await preview());
    serveRepository(movedCommit, movedFiles);

    const response = await post("/skills/import", body);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/source moved/);
    expect(mocks.listTree).not.toHaveBeenCalled();
    expect(mocks.readBlob).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stores the reviewed commit's content and provenance", async () => {
    serveRepository(reviewedCommit, reviewedFiles);
    const body = confirmation(await preview());

    const response = await post("/skills/import", { ...body, assignments: [{ type: "global" }] });

    expect(response.status).toBe(201);
    expect(mocks.listTree).toHaveBeenCalledOnce();
    expect(mocks.readBlob).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledOnce();
    const [input, actor, source] = mocks.create.mock.calls[0];
    expect(input).toMatchObject({ name: "deploy", assignments: [{ type: "global" }] });
    expect(actor).toBe("user-1");
    expect(source).toMatchObject({
      commitSha: reviewedCommit,
      subdirectory: "catalog/deploy",
      sourceSha256: body.expectedSourceSha256,
    });
  });

  it("keeps answering 409 when the name was claimed after the preview", async () => {
    serveRepository(reviewedCommit, reviewedFiles);
    const body = confirmation(await preview());
    mocks.create.mockRejectedValue(new SkillConflictError("A skill named deploy already exists"));

    const response = await post("/skills/import", body);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A skill named deploy already exists" });
  });
});
