import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewer } from "@open-inspect/shared";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import {
  resolveEnvironmentSelection,
  validateAutomationRepositoryGrants,
} from "./automation-validation";

const environments = vi.hoisted(() => ({
  getById: vi.fn(),
  getRepositoriesForEnvironment: vi.fn(),
}));
vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return environments;
  }),
}));

function database(rows: unknown[] = []): SqlDatabase {
  const statement: SqlStatement = {
    bind: () => statement,
    first: async () => null,
    all: async <T>() => ({ results: rows as T[], meta: { changes: 0 } }),
    run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
  };
  return { prepare: () => statement, batch: async () => [] };
}

const viewer: SessionViewer = {
  kind: "user",
  userId: "executor",
  roleKey: "member",
  permissions: ["environments.use"],
  suspended: false,
  memberships: new Map([["team-a", "member"]]),
};

describe("automation environment selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: "team-a" });
    environments.getRepositoriesForEnvironment.mockResolvedValue([
      { repo_owner: "group/subgroup", repo_name: "api", repo_id: 11 },
    ]);
  });

  it("returns each environment member for repository grant validation", async () => {
    await expect(
      resolveEnvironmentSelection(database(), ["env_a"], "team-a", viewer)
    ).resolves.toEqual([{ repoOwner: "group/subgroup", repoName: "api", repoId: 11 }]);
  });

  it("checks environment-use access independently of the automation permission", async () => {
    await expect(
      resolveEnvironmentSelection(database(), ["env_a"], "team-a", { ...viewer, permissions: [] })
    ).rejects.toMatchObject({ status: 403, reasonCode: "missing_permission" });
    expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
  });

  it.each([null, "team-b"])("rejects a different owner scope (%s)", async (ownerTeamId) => {
    await expect(
      resolveEnvironmentSelection(database(), ["env_a"], ownerTeamId, viewer)
    ).rejects.toMatchObject({ status: 409, reasonCode: "environment_team_mismatch" });
  });

  it("permits actorless service use of a workspace environment", async () => {
    environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: null });
    await expect(
      resolveEnvironmentSelection(database(), ["env_a"], null, { kind: "service", teamId: null })
    ).resolves.toEqual([]);
  });
});

describe("automation repository grants", () => {
  const grant = {
    grant_kind: "repository",
    repo_external_id: 11,
    repo_owner: "group/subgroup",
    repo_name: "api",
  };

  it("rejects null IDs even when the repository name matches a grant", async () => {
    const response = await validateAutomationRepositoryGrants(database([grant]), "team-a", [
      { repoOwner: "group/subgroup", repoName: "api", repoId: null },
    ]);
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      code: "target_team_missing_grant",
      repository: "group/subgroup/api",
    });
  });

  it("accepts matching IDs and refuses same-name recreated repositories", async () => {
    await expect(
      validateAutomationRepositoryGrants(database([grant]), "team-a", [
        { repoOwner: "group/subgroup", repoName: "api", repoId: 11 },
      ])
    ).resolves.toBeNull();
    const recreated = await validateAutomationRepositoryGrants(database([grant]), "team-a", [
      { repoOwner: "group/subgroup", repoName: "api", repoId: 22 },
    ]);
    expect(recreated?.status).toBe(409);
  });

  it("checks every numeric member after a granted repository", async () => {
    const response = await validateAutomationRepositoryGrants(database([grant]), "team-a", [
      { repoOwner: "group/subgroup", repoName: "api", repoId: 11 },
      { repoOwner: "acme", repoName: "ungranted", repoId: 22 },
    ]);
    await expect(response?.json()).resolves.toMatchObject({ repository: "acme/ungranted" });
  });

  it("honors installation grants and leaves workspace selections unrestricted", async () => {
    const repository = { repoOwner: "acme", repoName: "api", repoId: null };
    await expect(
      validateAutomationRepositoryGrants(
        database([{ grant_kind: "installation", repo_external_id: null }]),
        "team-a",
        [repository]
      )
    ).resolves.toBeNull();
    await expect(
      validateAutomationRepositoryGrants(database(), null, [repository])
    ).resolves.toBeNull();
  });
});
