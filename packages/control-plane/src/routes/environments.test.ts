import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SourceControlModule from "../source-control";
import type { RepositoryAccessResult } from "../source-control";
import type { Env } from "../types";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { HttpError, type RequestContext } from "./shared";
import { resolveEnvironmentRepositories } from "./environments";

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
}));

vi.mock("../source-control", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlModule>();
  return {
    ...actual,
    createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
  };
});

const env = {} as Env;
const ctx = {
  request_id: "request-1",
  trace_id: "trace-1",
  executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
} as unknown as RequestContext;

function access(overrides: Partial<RepositoryAccessResult>): RepositoryAccessResult {
  return {
    repoId: 1,
    repoOwner: "acme",
    repoName: "app",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("resolveEnvironmentRepositories", () => {
  beforeEach(() => {
    scmProvider.checkRepositoryAccess.mockReset();
  });

  it("persists canonical identities, branch defaults, and input order", async () => {
    scmProvider.checkRepositoryAccess.mockImplementation(
      async ({ owner, name }: { owner: string; name: string }) => {
        if (owner === "legacy/group" && name === "old-app") {
          return access({
            repoId: 7,
            repoOwner: "canonical/group/subgroup",
            repoName: "app",
            defaultBranch: "trunk",
          });
        }
        return access({
          repoId: 8,
          repoOwner: "other/nested",
          repoName: "api",
          defaultBranch: "develop",
        });
      }
    );

    const repositories = await resolveEnvironmentRepositories(
      env,
      [
        { repoOwner: "legacy/group", repoName: "old-app", baseBranch: null },
        { repoOwner: "other/nested", repoName: "api", baseBranch: "release" },
      ],
      ctx
    );

    expect(repositories).toEqual([
      {
        position: 0,
        repo_owner: "canonical/group/subgroup",
        repo_name: "app",
        repo_id: 7,
        base_branch: "trunk",
      },
      {
        position: 1,
        repo_owner: "other/nested",
        repo_name: "api",
        repo_id: 8,
        base_branch: "release",
      },
    ]);
  });

  it("rejects identities that duplicate after canonicalization", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(
      access({ repoId: 7, repoOwner: "canonical/group", repoName: "app" })
    );

    const error = await resolveEnvironmentRepositories(
      env,
      [
        { repoOwner: "legacy/group", repoName: "old-app", baseBranch: null },
        { repoOwner: "canonical/group", repoName: "app", baseBranch: null },
      ],
      ctx
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 400,
      message: "repositories resolve to the same repository: canonical/group/app",
    });
  });

  it("rejects canonical names that collide on checkout path", async () => {
    scmProvider.checkRepositoryAccess.mockImplementation(async ({ owner }: { owner: string }) =>
      access({ repoId: owner === "first/group" ? 1 : 2, repoOwner: owner, repoName: "app" })
    );

    const error = await resolveEnvironmentRepositories(
      env,
      [
        { repoOwner: "first/group", repoName: "legacy-app", baseBranch: null },
        { repoOwner: "second/group", repoName: "renamed-app", baseBranch: null },
      ],
      ctx
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 400,
      message: "repositories resolve to the same checkout path: app",
    });
  });
});
