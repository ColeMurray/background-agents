import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { createTestEnv, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import type { RequestContext } from "./shared";
import {
  authorizeTeamRepositories,
  authorizeWorkspaceRepositories,
} from "./workspace-repository-authorization";

const repository = { owner: "acme", name: "repo", repoId: 123 };

function context(): RequestContext {
  return {
    db: createTestEnv().DB,
    metrics: createRequestMetrics(),
    request_id: "request-1",
    trace_id: "trace-1",
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "user", userId: "user-1" },
    authorization: {
      userId: "user-1",
      suspendedAt: null,
      role: { id: "custom-role", key: null, name: "Custom" },
      permissions: [],
    },
    teamsEnforcementMode: "on",
  };
}

describe("workspace repository grants", () => {
  beforeEach(() => {
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockResolvedValue(
      new Map([["team-other", "member"]])
    );
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository").mockResolvedValue([
      "team-granted",
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([null, 0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric repository IDs (%s)",
    async (repoId) => {
      expect(
        (
          await authorizeWorkspaceRepositories(context(), {
            repositories: [{ ...repository, repoId }],
          })
        )?.status
      ).toBe(403);
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "preserves unowned repositories in %s mode, even for callers on no team",
    async (mode) => {
      const ctx = context();
      ctx.teamsEnforcementMode = mode;
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
      expect(await authorizeWorkspaceRepositories(ctx, { repositories: [repository] })).toBeNull();
      expect(
        await authorizeWorkspaceRepositories(ctx, { repositories: [repository], requireLead: true })
      ).toBeNull();
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "denies team-owned repositories to nonmembers in %s mode",
    async (mode) => {
      const ctx = context();
      ctx.teamsEnforcementMode = mode;
      expect(
        (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
      ).toBe(403);
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
      expect(
        (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
      ).toBe(403);
    }
  );

  it("accepts membership in any granting team rather than choosing a home team", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["team-member", "member"]])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-other",
      "team-member",
    ]);
    expect(
      await authorizeWorkspaceRepositories(context(), { repositories: [repository] })
    ).toBeNull();
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
  });

  it.each(["off", "shadow", "on"] as const)(
    "refuses retained archived memberships in %s mode without making the repository unowned",
    async (mode) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([["team-granted", "lead"]])
      );
      vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);
      const ctx = context();
      ctx.teamsEnforcementMode = mode;
      expect(
        (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
      ).toBe(403);
      expect(
        (
          await authorizeWorkspaceRepositories(ctx, {
            repositories: [repository],
            requireLead: true,
          })
        )?.status
      ).toBe(403);
      expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
    }
  );

  it("accepts an active granting team but not an archived lead", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([
        ["team-archived", "lead"],
        ["team-active", "member"],
      ])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
      "team-archived",
      "team-active",
    ]);
    vi.mocked(TeamStore.prototype.isActive).mockImplementation(
      async (teamId) => teamId === "team-active"
    );
    expect(
      await authorizeWorkspaceRepositories(context(), { repositories: [repository] })
    ).toBeNull();
    expect(
      (
        await authorizeWorkspaceRepositories(context(), {
          repositories: [repository],
          requireLead: true,
        })
      )?.status
    ).toBe(403);
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["team-active", "lead"]])
    );
    expect(
      await authorizeWorkspaceRepositories(context(), {
        repositories: [repository],
        requireLead: true,
      })
    ).toBeNull();
  });

  it("allows grants from different caller teams without adding repositories.use", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([
        ["team-1", "member"],
        ["team-2", "lead"],
      ])
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockImplementation(
      async (repoId) => [repoId === 123 ? "team-1" : "team-2"]
    );
    expect(
      await authorizeWorkspaceRepositories(context(), {
        repositories: [repository, { owner: "acme", name: "other", repoId: 456 }],
      })
    ).toBeNull();
  });

  it("does not need an enforcement mode to apply ownership checks", async () => {
    const ctx = context();
    delete ctx.teamsEnforcementMode;
    expect(
      (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
    ).toBe(403);
    vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
    expect(await authorizeWorkspaceRepositories(ctx, { repositories: [repository] })).toBeNull();
  });

  it.each(["member", "lead"] as const)(
    "permits a granting team's %s and limits secrets to leads",
    async (role) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([["team-granted", role]])
      );
      expect(
        await authorizeWorkspaceRepositories(context(), { repositories: [repository] })
      ).toBeNull();
      expect(
        (
          await authorizeWorkspaceRepositories(context(), {
            repositories: [repository],
            requireLead: true,
          })
        )?.status ?? null
      ).toBe(role === "lead" ? null : 403);
    }
  );

  it.each(["owner", "administrator"] as const)(
    "allows built-in %s access to every workspace repository surface",
    async (key) => {
      const ctx = context();
      if (!ctx.authorization) throw new Error("Expected authorization");
      ctx.authorization.role = { ...BUILT_IN_ROLE_REGISTRY[key], name: key };
      expect(
        await authorizeWorkspaceRepositories(ctx, {
          repositories: [repository],
          requireLead: true,
        })
      ).toBeNull();
      expect(await authorizeWorkspaceRepositories(ctx, { repositories: [repository] })).toBeNull();
    }
  );

  it("does not derive privileged access from a custom role's display name", async () => {
    const ctx = context();
    if (!ctx.authorization) throw new Error("Expected authorization");
    ctx.authorization.role.name = "Owner";
    expect(
      (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
    ).toBe(403);
  });

  it("fails closed without an admitted actor", async () => {
    const ctx = context();
    delete ctx.authorization;
    expect(
      (await authorizeWorkspaceRepositories(ctx, { repositories: [repository] }))?.status
    ).toBe(503);
  });
});

describe("explicit team repository grants", () => {
  beforeEach(() => {
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not substitute the caller's other teams for the persisted owner", async () => {
    const response = await authorizeTeamRepositories(context(), {
      teamId: "owner-team",
      repositories: [repository],
    });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "acme/repo",
    });
    expect(TeamStore.prototype.isActive).toHaveBeenCalledWith("owner-team");
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("owner-team");
  });

  it("denies an archived owner even if it has installation access", async () => {
    vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);
    expect(
      (
        await authorizeTeamRepositories(context(), {
          teamId: "owner-team",
          repositories: [repository],
        })
      )?.status
    ).toBe(403);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("preserves a workspace-owned target", async () => {
    expect(
      await authorizeTeamRepositories(context(), {
        teamId: null,
        repositories: [repository],
      })
    ).toBeNull();
    expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("allows a granted active owner without requiring a new use permission", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
    ]);
    expect(
      await authorizeTeamRepositories(context(), {
        teamId: "owner-team",
        repositories: [repository],
      })
    ).toBeNull();
  });

  it("allows a null repository ID only with an installation grant", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);

    expect(
      await authorizeTeamRepositories(context(), {
        teamId: "owner-team",
        repositories: [{ ...repository, repoId: null }],
      })
    ).toBeNull();
  });

  it("denies a null repository ID with only repository grants", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
    ]);

    const response = await authorizeTeamRepositories(context(), {
      teamId: "owner-team",
      repositories: [{ ...repository, repoId: null }],
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "acme/repo",
    });
  });

  it("names the first uncovered repository while preserving readonly target order", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
    ]);
    const repositories = [
      repository,
      { owner: "group/subgroup", name: "api", repoId: 456 },
      { owner: "acme", name: "other", repoId: 789 },
    ] as const;

    const response = await authorizeTeamRepositories(context(), {
      teamId: "owner-team",
      repositories,
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ repository: "group/subgroup/api" });
  });

  it("checks team activity but needs no grants for an empty repository set", async () => {
    expect(
      await authorizeTeamRepositories(context(), { teamId: "owner-team", repositories: [] })
    ).toBeNull();
    expect(TeamStore.prototype.isActive).toHaveBeenCalledWith("owner-team");
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });
});
