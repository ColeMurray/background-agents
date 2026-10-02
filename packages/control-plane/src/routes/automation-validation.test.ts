import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { createTestEnv, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { resolveRepoOrError, type RequestContext } from "./shared";
import type * as SharedRoutes from "./shared";
import { resolveRepositorySelection } from "./automation-validation";

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
