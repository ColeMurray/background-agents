import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { Principal } from "../auth/principal";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { TeamStore } from "../db/teams";
import type { SqlStatement } from "../db/sql-database";
import {
  createTestEnv,
  emptyStatement,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import type { RequestContext } from "./shared";
import { authorizeSessionTarget, type SessionTarget } from "./session-target-authorization";

const repository = { owner: "acme/group", name: "app", repoId: 7 };
const target: SessionTarget = { teamId: "team_alpha", repositories: [repository] };
const user: Principal = { kind: "user", userId: "user-1" };
const sandbox: Principal = { kind: "sandbox", sessionId: "parent-1" };

function context(
  principal: Principal = user,
  permissions: PermissionId[] = ["repositories.use", "environments.use"],
  grants: readonly {
    grant_kind: "installation" | "repository";
    repo_external_id: number | null;
  }[] = []
): RequestContext {
  const statement: SqlStatement = {
    ...emptyStatement(),
    bind: () => statement,
    all: async <T>() => ({
      results: [...grants] as T[],
      meta: { changes: 0 },
    }),
  };
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    db: { ...createTestEnv().DB, prepare: vi.fn(() => statement) },
    principal,
    authorization: {
      userId: "user-1",
      suspendedAt: null,
      role: { id: "role-1", key: null, name: "Test" },
      permissions,
    },
  };
}

describe("authorizeSessionTarget", () => {
  beforeEach(() => {
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([user, { kind: "service", service: "slack-bot", actor: null } satisfies Principal])(
    "checks $kind repository permission before looking up grants",
    async (principal) => {
      const ctx = context(principal, []);
      const response = await authorizeSessionTarget(ctx, target);

      expect(response?.status).toBe(403);
      await expect(response?.json()).resolves.toEqual({
        error: "Forbidden",
        code: "permission_required",
        permission: "repositories.use",
      });
      expect(ctx.db.prepare).not.toHaveBeenCalled();
      expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
    }
  );

  it("requires environment permission instead of repository permission", async () => {
    const ctx = context(user, ["repositories.use"]);
    const response = await authorizeSessionTarget(ctx, { ...target, environmentId: "env_1" });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ permission: "environments.use" });
    expect(ctx.db.prepare).not.toHaveBeenCalled();
    expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
  });

  it("checks environment member grants without requiring repository permission", async () => {
    const response = await authorizeSessionTarget(context(user, ["environments.use"]), {
      ...target,
      environmentId: "env_1",
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "acme/group/app",
    });
  });

  it("fails closed when user authorization is unavailable", async () => {
    const ctx = context();
    delete ctx.authorization;
    const response = await authorizeSessionTarget(ctx, target);

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ code: "authorization_unavailable" });
    expect(ctx.db.prepare).not.toHaveBeenCalled();
  });

  it("enforces the service capability ceiling before actor permissions", async () => {
    const ctx = context({ kind: "service", service: "web", actor: null });
    const response = await authorizeSessionTarget(ctx, target);

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ code: "service_capability_required" });
    expect(ctx.db.prepare).not.toHaveBeenCalled();
  });

  it("bypasses grants for workspace-owned targets", async () => {
    const ctx = context();
    expect(await authorizeSessionTarget(ctx, { ...target, teamId: null })).toBeNull();
    expect(ctx.db.prepare).not.toHaveBeenCalled();
    expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
  });

  it.each([{ repositories: undefined }, { repositories: [] }])(
    "refuses inactive ownership for a repo-less target",
    async ({ repositories }) => {
      const ctx = context(user, []);
      vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);

      const denied = await authorizeSessionTarget(ctx, { teamId: "team_alpha", repositories });
      expect(denied?.status).toBe(403);
      await expect(denied?.json()).resolves.toMatchObject({ code: "team_not_active" });
      expect(ctx.db.prepare).not.toHaveBeenCalled();
      expect(TeamStore.prototype.isActive).toHaveBeenCalledWith("team_alpha");
    }
  );

  it("preflights environment permission without team lookup when repository members are absent", async () => {
    const ctx = context(user, ["environments.use"]);

    expect(await authorizeSessionTarget(ctx, { teamId: null, environmentId: "env_1" })).toBeNull();
    expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
    expect(ctx.db.prepare).not.toHaveBeenCalled();
  });

  it.each([user, sandbox])("rejects an inactive target team for $kind", async (principal) => {
    const ctx = context(principal);
    vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);

    const response = await authorizeSessionTarget(ctx, target);

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Team is not active",
      code: "team_not_active",
    });
    expect(TeamStore.prototype.isActive).toHaveBeenCalledWith("team_alpha");
    expect(ctx.db.prepare).not.toHaveBeenCalled();
  });

  it("matches grants by numeric repository ID", async () => {
    const ctx = context(
      user,
      ["repositories.use"],
      [{ grant_kind: "repository", repo_external_id: 7 }]
    );
    expect(await authorizeSessionTarget(ctx, target)).toBeNull();
  });

  it("reports the first uncovered repository in target order", async () => {
    const ctx = context(
      user,
      ["repositories.use"],
      [{ grant_kind: "repository", repo_external_id: 7 }]
    );
    const response = await authorizeSessionTarget(ctx, {
      ...target,
      repositories: [repository, { owner: "acme", name: "api", repoId: 8 }],
    });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ repository: "acme/api" });
  });

  it.each([null, undefined])(
    "fails closed for unresolved ID %s without an installation grant",
    async (repoId) => {
      const ctx = context(
        user,
        ["repositories.use"],
        [{ grant_kind: "repository", repo_external_id: 7 }]
      );
      const response = await authorizeSessionTarget(ctx, {
        ...target,
        repositories: [{ ...repository, repoId }],
      });
      expect(response?.status).toBe(409);
    }
  );

  it.each([user, sandbox])(
    "allows an active repo-less team target for $kind without grants",
    async (principal) => {
      const ctx = context(principal, []);
      expect(
        await authorizeSessionTarget(ctx, { teamId: "team_alpha", repositories: [] })
      ).toBeNull();
      expect(TeamStore.prototype.isActive).toHaveBeenCalledWith("team_alpha");
      expect(ctx.db.prepare).not.toHaveBeenCalled();
    }
  );

  it("allows unresolved IDs only with an installation grant", async () => {
    const ctx = context(
      user,
      ["repositories.use"],
      [{ grant_kind: "installation", repo_external_id: null }]
    );
    expect(
      await authorizeSessionTarget(ctx, {
        ...target,
        repositories: [{ owner: "acme", name: "app" }],
      })
    ).toBeNull();
  });

  it("still checks team grants for a sandbox without user permissions", async () => {
    const ctx = context(sandbox, []);
    delete ctx.authorization;
    const response = await authorizeSessionTarget(ctx, target);

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ code: "target_team_missing_grant" });
  });

  it("allows a sandbox with a covered team target without user authorization", async () => {
    const ctx = context(sandbox, [], [{ grant_kind: "repository", repo_external_id: 7 }]);
    delete ctx.authorization;
    expect(await authorizeSessionTarget(ctx, target)).toBeNull();
  });
});
