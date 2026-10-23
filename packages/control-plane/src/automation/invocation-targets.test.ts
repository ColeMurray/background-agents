import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import * as repositoryResolution from "./repository";
import { loadInvocationTargets, resolveInvocationTargets } from "./invocation-targets";

const requested = { repo_owner: "acme", repo_name: "api", repo_id: 1, base_branch: "main" };
const repository = { repoOwner: "acme", repoName: "api", repoId: 1, baseBranch: "release" };

describe("invocation target preparation", () => {
  it("uses a complete resolved snapshot without reading stored targets or repeating SCM resolution", async () => {
    const store = { getRepositoriesForAutomation: vi.fn(), getEnvironmentsForAutomation: vi.fn() };
    const lookup = vi.spyOn(repositoryResolution, "resolveAutomationRepositories");
    try {
      const snapshot = { repositories: [{ repository, error: null }], environments: [] };
      const targets = await loadInvocationTargets(store, "auto", { kind: "resolved", snapshot });
      expect(await resolveInvocationTargets({} as Env, targets)).toMatchObject(snapshot);
      expect(store.getRepositoriesForAutomation).not.toHaveBeenCalled();
      expect(store.getEnvironmentsForAutomation).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
  it("retains the requested snapshot when a stored repository resolves to a different identity", async () => {
    const lookup = vi
      .spyOn(repositoryResolution, "resolveAutomationRepositories")
      .mockResolvedValue([{ requested, repository: { ...repository, repoId: 2 }, error: null }]);
    try {
      const result = await resolveInvocationTargets(
        {} as Env,
        { kind: "stored", repositories: [requested], environments: [] },
        1
      );
      expect(result.repositories).toEqual([
        {
          repository: { repoOwner: "acme", repoName: "api", repoId: 1, baseBranch: "main" },
          error: "Repository identity changed during event resolution",
        },
      ]);
    } finally {
      lookup.mockRestore();
    }
  });
});
