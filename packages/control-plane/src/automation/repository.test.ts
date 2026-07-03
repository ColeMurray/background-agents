import { describe, expect, it, vi } from "vitest";
import type { NewAutomationRepository } from "../db/automation-store";
import type { Env } from "../types";
import type { SourceControlProvider } from "../source-control";
import { resolveAutomationRepositories } from "./repository";

function repo(overrides?: Partial<NewAutomationRepository>): NewAutomationRepository {
  return {
    repo_owner: "acme",
    repo_name: "web-app",
    repo_id: 111,
    base_branch: "release",
    ...overrides,
  };
}

function createProvider(
  checkRepositoryAccess: SourceControlProvider["checkRepositoryAccess"]
): SourceControlProvider {
  return { checkRepositoryAccess } as unknown as SourceControlProvider;
}

describe("resolveAutomationRepositories", () => {
  it("resolves access and keeps the selection's fixed branch", async () => {
    const provider = createProvider(
      vi.fn().mockResolvedValue({
        repoId: 98765,
        repoOwner: "acme",
        repoName: "web-app",
        defaultBranch: "main",
      })
    );

    const [resolution] = await resolveAutomationRepositories({} as Env, [repo()], provider);

    expect(resolution.error).toBeNull();
    expect(resolution.repository).toEqual({
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 98765,
      baseBranch: "release",
    });
    expect(provider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "web-app",
    });
  });

  it("falls back to the repository default branch when no fixed branch is configured", async () => {
    const provider = createProvider(
      vi.fn().mockResolvedValue({
        repoId: 98765,
        repoOwner: "acme",
        repoName: "web-app",
        defaultBranch: "develop",
      })
    );

    const [resolution] = await resolveAutomationRepositories(
      {} as Env,
      [repo({ base_branch: null })],
      provider
    );

    expect(resolution.repository).toMatchObject({ baseBranch: "develop" });
  });

  it("returns no resolutions (and skips the provider) for an empty selection", async () => {
    const provider = createProvider(vi.fn());

    await expect(resolveAutomationRepositories({} as Env, [], provider)).resolves.toEqual([]);
    expect(provider.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it("captures an inaccessible repository as a per-repo error entry", async () => {
    const provider = createProvider(vi.fn().mockResolvedValue(null));

    const [resolution] = await resolveAutomationRepositories({} as Env, [repo()], provider);

    expect(resolution.repository).toBeNull();
    expect(resolution.error).toBe("Repository is not accessible for the configured SCM provider");
    expect(resolution.requested).toEqual(repo());
  });

  it("one failing repository never blocks its siblings", async () => {
    const provider = createProvider(
      vi.fn().mockImplementation(async ({ name }: { owner: string; name: string }) => {
        if (name === "broken") throw new Error("SCM exploded");
        return { repoId: 1, repoOwner: "acme", repoName: name, defaultBranch: "main" };
      })
    );

    const resolutions = await resolveAutomationRepositories(
      {} as Env,
      [repo({ repo_name: "broken" }), repo({ repo_name: "web-app" })],
      provider
    );

    expect(resolutions[0].repository).toBeNull();
    expect(resolutions[0].error).toBe("SCM exploded");
    expect(resolutions[1].error).toBeNull();
    expect(resolutions[1].repository).toMatchObject({ repoName: "web-app" });
  });
});
