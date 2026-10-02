import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewer } from "@open-inspect/shared";
import type { SqlDatabase } from "../db/sql-database";
import { resolveEnvironmentSelection, TargetSelectionError } from "./automation-validation";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { createTestEnv, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { resolveRepoOrError, type RequestContext } from "./shared";
import type * as SharedRoutes from "./shared";
import { resolveRepositorySelection } from "./automation-validation";

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
    ).resolves.toEqual([{ repoOwner: "group/subgroup", repoName: "api", repoId: 11 }]);
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

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedRoutes>()),
  resolveRepoOrError: vi.fn(),
}));

const env = createTestEnv();
const repositories = [{ repoOwner: "acme", repoName: "app", baseBranch: null }];

function context(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    db: env.DB,
    principal: { kind: "user", userId: "user-1" },
    authorization: {
      userId: "user-1",
      suspendedAt: null,
      role: { id: "role-1", key: null, name: "Test" },
      permissions: ["repositories.use"],
    },
  };
}

describe("resolveRepositorySelection target authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 7,
      repoOwner: "acme",
      repoName: "app",
      defaultBranch: "main",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("checks user target permission before SCM resolution", async () => {
    const ctx = context();
    if (ctx.authorization) ctx.authorization.permissions = [];

    const result = await resolveRepositorySelection(env, repositories, ctx, null);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected target denial");
    expect(result.status).toBe(403);
    await expect(result.json()).resolves.toMatchObject({ permission: "repositories.use" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("checks service actor target permission before SCM resolution", async () => {
    const ctx = context();
    ctx.principal = { kind: "service", service: "slack-bot", actor: null };
    if (ctx.authorization) ctx.authorization.permissions = [];

    const result = await resolveRepositorySelection(env, repositories, ctx, null);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected target denial");
    expect(result.status).toBe(403);
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("checks the resolved ID against the target team's grants", async () => {
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers").mockResolvedValue(false);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);

    const result = await resolveRepositorySelection(env, repositories, context(), "team_alpha");

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected target denial");
    expect(result.status).toBe(409);
    await expect(result.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "acme/app",
    });
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
  });

  it("keeps workspace-owned selections without team grant lookups", async () => {
    const grants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam");

    await expect(resolveRepositorySelection(env, repositories, context(), null)).resolves.toEqual([
      { repo_owner: "acme", repo_name: "app", repo_id: 7, base_branch: "main" },
    ]);
    expect(grants).not.toHaveBeenCalled();
  });
});
