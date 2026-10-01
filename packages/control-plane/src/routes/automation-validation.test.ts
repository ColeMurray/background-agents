import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewer } from "@open-inspect/shared";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import {
  resolveEnvironmentSelection,
  TargetSelectionError,
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

async function selectionFailure(selection: Promise<unknown>) {
  try {
    await selection;
  } catch (error) {
    if (!(error instanceof TargetSelectionError)) throw error;
    const response = error.response();
    return { status: response.status, body: await response.text() };
  }
  throw new Error("Expected environment selection to fail");
}

describe("automation environment selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: "team-a" });
    environments.getRepositoriesForEnvironment.mockResolvedValue([
      { repo_owner: "group/subgroup", repo_name: "api", repo_id: 11 },
    ]);
  });

  it("returns repositories for use-only viewers without read permission", async () => {
    await expect(
      resolveEnvironmentSelection(database(), ["env_a"], "team-a", viewer)
    ).resolves.toEqual([{ repoOwner: "group/subgroup", repoName: "api", repoId: 11 }]);
  });

  it.each(["team-a", "team-b"])(
    "checks environment-use access before ownership compatibility with %s",
    async (ownerTeamId) => {
      await expect(
        resolveEnvironmentSelection(database(), ["env_a"], ownerTeamId, {
          ...viewer,
          permissions: [],
        })
      ).rejects.toMatchObject({ status: 403, reasonCode: "missing_permission" });
      expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    }
  );

  it.each(
    [true, false].flatMap((requireUse) =>
      [null, "team-a", "team-b"].map((ownerTeamId) => ({ requireUse, ownerTeamId }))
    )
  )(
    "matches hidden and missing responses for owner $ownerTeamId with requireUse=$requireUse",
    async ({ requireUse, ownerTeamId }) => {
      const actor: SessionViewer = {
        ...viewer,
        permissions: requireUse ? ["environments.use"] : [],
      };
      environments.getById.mockResolvedValue(null);
      const missing = await selectionFailure(
        resolveEnvironmentSelection(database(), ["env_hidden"], ownerTeamId, actor, requireUse)
      );
      expect(missing).toEqual({
        status: 400,
        body: JSON.stringify({ error: "Environment not found: env_hidden" }),
      });

      environments.getById.mockResolvedValue({ id: "env_hidden", owner_team_id: "team-b" });
      const hidden = await selectionFailure(
        resolveEnvironmentSelection(database(), ["env_hidden"], ownerTeamId, actor, requireUse)
      );
      expect(hidden).toEqual(missing);
      expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    }
  );

  it.each(
    [true, false].flatMap((requireUse) =>
      [
        ["env_visible_cross", "env_hidden_z", "env_missing", "env_hidden_a"],
        ["env_hidden_a", "env_missing", "env_hidden_z", "env_visible_cross"],
      ].map((environmentIds) => ({ requireUse, environmentIds }))
    )
  )(
    "aggregates unavailable IDs before conflicts, requireUse=$requireUse: $environmentIds",
    async ({ requireUse, environmentIds }) => {
      const actor: SessionViewer = {
        ...viewer,
        permissions: requireUse ? ["environments.use"] : [],
      };
      environments.getById.mockImplementation(async (id: string) =>
        id === "env_visible_cross" ? { id, owner_team_id: "team-a" } : null
      );
      const missing = await selectionFailure(
        resolveEnvironmentSelection(database(), environmentIds, null, actor, requireUse)
      );
      expect(missing).toEqual({
        status: 400,
        body: JSON.stringify({
          error: `Environment not found: ${environmentIds
            .filter((id) => id !== "env_visible_cross")
            .join(", ")}`,
        }),
      });

      environments.getById.mockImplementation(async (id: string) => {
        if (id === "env_missing") return null;
        return { id, owner_team_id: id === "env_visible_cross" ? "team-a" : "team-b" };
      });
      const hidden = await selectionFailure(
        resolveEnvironmentSelection(database(), environmentIds, null, actor, requireUse)
      );
      expect(hidden).toEqual(missing);
      expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    }
  );

  it("resolves unchanged environment repositories without requiring viewer use access", async () => {
    await expect(
      resolveEnvironmentSelection(
        database(),
        ["env_a"],
        "team-a",
        { ...viewer, permissions: [] },
        false
      )
    ).resolves.toEqual([{ repoOwner: "group/subgroup", repoName: "api", repoId: 11 }]);
  });

  it("still checks the team of a visible unchanged environment", async () => {
    await expect(
      resolveEnvironmentSelection(
        database(),
        ["env_a"],
        "team-b",
        { ...viewer, permissions: [] },
        false
      )
    ).rejects.toMatchObject({ status: 409, reasonCode: "environment_team_mismatch" });
  });

  it("still rejects missing unchanged environments", async () => {
    environments.getById.mockResolvedValue(null);
    await expect(
      resolveEnvironmentSelection(
        database(),
        ["env_a"],
        "team-a",
        { ...viewer, permissions: [] },
        false
      )
    ).rejects.toMatchObject({ status: 400, message: "Environment not found: env_a" });
  });

  it.each([null, "team-b"])("rejects a visible different owner scope (%s)", async (ownerTeamId) => {
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
