import { describe, expect, it, vi } from "vitest";
import { SourceControlProviderError, type SourceControlProvider } from "../source-control";
import { resolveWebhookRepository } from "./webhook-repository";

const config = { repoOwnerPath: "$.owner", repoNamePath: "$.name", branchPath: "$.branch" };

describe("classified webhook repository failures", () => {
  it.each(["repository", "branch"])(
    "preserves permanent %s access denial and its cause",
    async (boundary) => {
      const cause = new SourceControlProviderError("Access denied", "permanent", 403);
      const provider = {
        checkRepositoryAccess: vi.fn().mockResolvedValue({
          repoOwner: "acme",
          repoName: "api",
          repoId: 1,
          defaultBranch: "main",
        }),
        getBranchHead: vi.fn().mockResolvedValue("a".repeat(40)),
      };
      (boundary === "repository"
        ? provider.checkRepositoryAccess
        : provider.getBranchHead
      ).mockRejectedValue(cause);
      await expect(
        resolveWebhookRepository(
          config,
          { owner: "acme", name: "api" },
          provider as unknown as SourceControlProvider
        )
      ).rejects.toMatchObject({ status: 403, cause });
    }
  );
  it.each([403, 429, 503])("preserves a transient %s as retryable", async (httpStatus) => {
    const cause = new SourceControlProviderError("Unavailable", "transient", httpStatus);
    const provider = { checkRepositoryAccess: vi.fn().mockRejectedValue(cause) };
    await expect(
      resolveWebhookRepository(
        config,
        { owner: "acme", name: "api" },
        provider as unknown as SourceControlProvider
      )
    ).rejects.toMatchObject({ status: 503, cause });
  });
});

describe("webhook branch Unicode validation", () => {
  it.each(["release/\uD800", "release/\uDFFF"])(
    "rejects an unpaired surrogate before SCM lookup: %j",
    async (branch) => {
      const provider = {
        checkRepositoryAccess: vi.fn().mockResolvedValue({
          repoOwner: "acme",
          repoName: "api",
          repoId: 1,
          defaultBranch: "main",
        }),
        getBranchHead: vi.fn().mockImplementation(async ({ branch }) => encodeURIComponent(branch)),
      };
      await expect(
        resolveWebhookRepository(
          config,
          { owner: "acme", name: "api", branch },
          provider as unknown as SourceControlProvider
        )
      ).rejects.toMatchObject({ status: 400 });
      expect(provider.checkRepositoryAccess).not.toHaveBeenCalled();
      expect(provider.getBranchHead).not.toHaveBeenCalled();
    }
  );
  it("accepts a well-formed surrogate pair in a branch", async () => {
    const branch = "release/🚀";
    const provider = {
      checkRepositoryAccess: vi.fn().mockResolvedValue({
        repoOwner: "acme",
        repoName: "api",
        repoId: 1,
        defaultBranch: "main",
      }),
      getBranchHead: vi.fn().mockImplementation(async ({ branch }) => encodeURIComponent(branch)),
    };
    await expect(
      resolveWebhookRepository(
        config,
        { owner: "acme", name: "api", branch },
        provider as unknown as SourceControlProvider
      )
    ).resolves.toMatchObject({ baseBranch: branch });
  });
});
