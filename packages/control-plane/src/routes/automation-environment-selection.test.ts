import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewer } from "@open-inspect/shared";
import type { SqlDatabase } from "../db/sql-database";
import { resolveEnvironmentSelection, TargetSelectionError } from "./automation-validation";

const environments = vi.hoisted(() => ({
  getById: vi.fn(),
  getRepositoriesForEnvironment: vi.fn(),
}));
vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return environments;
  }),
}));
const db: SqlDatabase = {
  prepare: () => {
    throw new Error("Unexpected SQL query");
  },
  batch: async () => [],
};
const viewer: SessionViewer = {
  kind: "user",
  userId: "executor",
  roleKey: "member",
  permissions: ["environments.use"],
  suspended: false,
  memberships: new Map([["team-a", "member"]]),
};

async function selectionFailure(selection: Promise<unknown>) {
  const result = await selection.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(TargetSelectionError);
  const response = (result as TargetSelectionError).response();
  return { status: response.status, ...(await response.json<Record<string, unknown>>()) };
}

describe("automation environment selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: "team-a" });
    environments.getRepositoriesForEnvironment.mockResolvedValue([
      { repo_owner: "group/subgroup", repo_name: "api", repo_id: 11 },
    ]);
  });

  it.each([true, false])("resolves use-only/unchanged targets (%s)", async (requireUse) => {
    const actor = { ...viewer, permissions: requireUse ? viewer.permissions : [] };
    await expect(
      resolveEnvironmentSelection(db, ["env_a"], "team-a", actor, requireUse)
    ).resolves.toEqual([{ owner: "group/subgroup", name: "api", repoId: 11 }]);
  });

  it("checks replacement-use access before owner compatibility", async () => {
    await expect(
      resolveEnvironmentSelection(db, ["env_a"], "team-b", { ...viewer, permissions: [] })
    ).rejects.toMatchObject({ status: 403, reasonCode: "missing_permission" });
    expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "aggregates hidden/missing IDs in input order before conflicts with requireUse=%s",
    async (requireUse) => {
      const ids = ["env_visible_cross", "env_hidden_z", "env_missing", "env_hidden_a"];
      const actor = { ...viewer, permissions: requireUse ? viewer.permissions : [] };
      environments.getById.mockImplementation(async (id: string) =>
        id === "env_visible_cross" ? { id, owner_team_id: "team-a" } : null
      );
      const missing = await selectionFailure(
        resolveEnvironmentSelection(db, ids, null, actor, requireUse)
      );
      expect(missing).toEqual({
        status: 400,
        error: "Environment not found: env_hidden_z, env_missing, env_hidden_a",
      });
      environments.getById.mockImplementation(async (id: string) =>
        id === "env_missing"
          ? null
          : { id, owner_team_id: id === "env_visible_cross" ? "team-a" : "team-b" }
      );
      expect(
        await selectionFailure(resolveEnvironmentSelection(db, ids, null, actor, requireUse))
      ).toEqual(missing);
      expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["team-a", null, true],
    ["team-a", "team-b", true],
    [null, "team-a", true],
    ["team-a", "team-b", false],
  ] as const)(
    "rejects owner mismatch %s -> %s with requireUse=%s",
    async (environmentTeamId, ownerTeamId, requireUse) => {
      environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: environmentTeamId });
      const actor = { ...viewer, permissions: requireUse ? viewer.permissions : [] };
      const result = await selectionFailure(
        resolveEnvironmentSelection(db, ["env_a"], ownerTeamId, actor, requireUse)
      );
      expect(result).toEqual({
        status: 409,
        error: "Environment must belong to the automation's owner team",
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
      expect(environments.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    }
  );
});
