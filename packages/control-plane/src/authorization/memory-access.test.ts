import { describe, expect, it, vi } from "vitest";
import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { MemoryScope } from "@open-inspect/shared/types/memories";
import type { EnvironmentRow } from "../db/environments";
import type { MemoryPartition } from "../memory/partition";
import type { MemoryRecord } from "../memory/types";
import {
  MemoryManagementPolicy,
  SessionMemoryAccessPolicy,
  type MemoryManagementDecision,
  type MemoryManagementPolicyDeps,
  type SessionMemoryAccessPolicyDeps,
} from "./memory-access";
import { AuthorizationError } from "./service";

const USER = "11111111111111111111111111111111";
const api: MemoryPartition = { type: "repository", repoId: 1 };
const apiScope = { type: "repository" as const, repoOwner: "acme", repoName: "api" };
const dev: MemoryPartition = { type: "environment", environmentId: "dev" };
const personal: MemoryPartition = { type: "personal", userId: USER };

function authorization(
  permissions: PermissionId[] = [],
  overrides: Partial<EffectiveAuthorization> = {}
): EffectiveAuthorization {
  return {
    userId: USER,
    suspendedAt: null,
    role: { id: "role", key: "member", name: "Member" },
    permissions,
    ...overrides,
  } as EffectiveAuthorization;
}

const ungranted = api;

function sessionPolicy(overrides: Partial<SessionMemoryAccessPolicyDeps> = {}) {
  const deps = {
    teams: { isActive: vi.fn(async () => true) },
    grants: { covers: vi.fn<SessionMemoryAccessPolicyDeps["grants"]["covers"]>(async () => true) },
    environments: {
      getById: vi.fn(async (id: string) =>
        id === "dev" ? ({ id, owner_team_id: "team" } as EnvironmentRow) : null
      ),
    },
    authorization: { getEffectiveAuthorization: vi.fn(async () => authorization()) },
    repositoryGrants: {
      ungrantedRepository: vi.fn<
        SessionMemoryAccessPolicyDeps["repositoryGrants"]["ungrantedRepository"]
      >(async () => null),
    },
  };
  return { deps, policy: new SessionMemoryAccessPolicy({ ...deps, ...overrides }) };
}

const team = { userId: USER, ownerTeamId: "team" };
const workspace = { userId: USER, ownerTeamId: null };
const GRANTED = { kind: "granted" };

describe("SessionMemoryAccessPolicy", () => {
  it("checks team activity and grant coverage for team sessions", async () => {
    const { policy, deps } = sessionPolicy();
    expect(await policy.check(team, [api, dev, personal])).toEqual(GRANTED);
    expect(deps.grants.covers).toHaveBeenCalledWith("team", [1]);
    expect(deps.authorization.getEffectiveAuthorization).not.toHaveBeenCalled();
    deps.grants.covers.mockResolvedValueOnce(false);
    expect(await policy.check(team, [api])).toEqual({
      kind: "denied",
      reason: "repository_ungranted",
    });
    deps.teams.isActive.mockResolvedValueOnce(false);
    expect(await policy.check(team, [personal])).toEqual({
      kind: "denied",
      reason: "team_inactive",
    });
  });

  it("evaluates workspace sessions as their owner, loading authorization once", async () => {
    const { policy, deps } = sessionPolicy();
    expect(await policy.check(workspace, [api])).toEqual(GRANTED);
    deps.repositoryGrants.ungrantedRepository.mockResolvedValueOnce(ungranted);
    expect(await policy.check(workspace, [api])).toEqual({
      kind: "denied",
      reason: "repository_ungranted",
      partition: api,
    });
    expect(deps.authorization.getEffectiveAuthorization).toHaveBeenCalledTimes(1);
    expect(deps.repositoryGrants.ungrantedRepository).toHaveBeenCalledWith(authorization(), [api]);
  });

  it.each([
    ["is suspended", async () => authorization([], { suspendedAt: 1 })],
    [
      "has no authorization",
      async () => {
        throw new AuthorizationError(404, "not_found");
      },
    ],
  ])("denies a workspace session whose owner %s", async (_case, load) => {
    const { policy } = sessionPolicy({ authorization: { getEffectiveAuthorization: load } });
    expect(await policy.check(workspace, [])).toEqual({
      kind: "denied",
      reason: "owner_unavailable",
    });
  });

  it("denies environments that are missing or owned by another team", async () => {
    const { policy } = sessionPolicy();
    expect(await policy.check({ userId: USER, ownerTeamId: "other" }, [dev])).toEqual({
      kind: "denied",
      reason: "environment_unavailable",
      partition: dev,
    });
    const gone: MemoryPartition = { type: "environment", environmentId: "gone" };
    expect(await policy.check(team, [gone])).toMatchObject({ reason: "environment_unavailable" });
  });
});

function managementPolicy(
  permissions: PermissionId[],
  overrides: Partial<MemoryManagementPolicyDeps> = {}
) {
  const deps = {
    userId: USER,
    authorization: authorization(permissions),
    repositories: {
      resolve: vi.fn<MemoryManagementPolicyDeps["repositories"]["resolve"]>(async () => ({
        repoId: 1,
        repoOwner: "acme",
        repoName: "api",
        defaultBranch: "main",
      })),
    },
    environments: {
      evaluate: vi.fn<MemoryManagementPolicyDeps["environments"]["evaluate"]>(async () => ({
        kind: "allowed" as const,
        effectivePermission: null,
        admission: {} as never,
      })),
    },
    repositoryGrants: {
      ungrantedRepository: vi.fn<
        MemoryManagementPolicyDeps["repositoryGrants"]["ungrantedRepository"]
      >(async () => null),
    },
  };
  return { deps, policy: new MemoryManagementPolicy({ ...deps, ...overrides }) };
}

const recordIn = (partition: MemoryPartition, scope: MemoryScope = { type: "personal" }) =>
  ({ partition, scope }) as MemoryRecord;
/** The denial reason, or "granted". */
const outcome = (decision: MemoryManagementDecision) =>
  decision.kind === "denied" ? decision.denial.reason : decision.kind;

describe("MemoryManagementPolicy", () => {
  it("keeps personal memory owner-only and requires the personal permission", async () => {
    const { policy } = managementPolicy(["memories.manage_own"]);
    expect(await policy.authorizeScope({ type: "personal" }, "write")).toEqual({
      kind: "granted",
      partition: personal,
      scope: { type: "personal" },
      canManage: true,
    });
    const other = recordIn({ type: "personal", userId: "someone-else" });
    expect(outcome(await policy.authorizeRecord(other, "read"))).toBe("not_found");
    const { policy: noPermission } = managementPolicy([]);
    expect(outcome(await noPermission.authorizeScope({ type: "personal" }, "read"))).toBe(
      "forbidden"
    );
  });

  it("resolves repositories to stable partitions and requires lead grants to manage", async () => {
    const { policy, deps } = managementPolicy([
      "repositories.read",
      "repositories.settings.manage",
    ]);
    const scope = { type: "repository" as const, repoOwner: "acme", repoName: "api" };
    deps.repositoryGrants.ungrantedRepository.mockImplementation(async (_auth, _repos, options) =>
      options?.requireLead ? ungranted : null
    );
    expect(await policy.authorizeScope(scope, "read")).toEqual({
      kind: "granted",
      partition: api,
      scope: apiScope,
      canManage: false,
    });
    expect(await policy.authorizeScope(scope, "write")).toEqual({
      kind: "denied",
      denial: { reason: "forbidden", message: "Repository memory management permission required" },
    });
  });

  it("reports the repository that failed its grant check", async () => {
    const { policy, deps } = managementPolicy(["repositories.read"]);
    deps.repositoryGrants.ungrantedRepository.mockResolvedValueOnce(ungranted);
    expect(
      await policy.authorizeScope(
        { type: "repository", repoOwner: "acme", repoName: "api" },
        "read"
      )
    ).toEqual({
      kind: "denied",
      denial: {
        reason: "forbidden",
        message: "Repository grant required",
        code: "repository_grant_required",
        reasonCode: "repository_grant_required",
        repository: "acme/api",
      },
    });
  });

  it("authorizes records by their stored repository ID without resolving names", async () => {
    const { policy, deps } = managementPolicy(["repositories.read"]);
    // Stored display names may be stale after a rename; the stable ID is what is checked.
    const renamed = recordIn(api, { ...apiScope, repoOwner: "old-owner" });
    expect(await policy.authorizeRecord(renamed, "read")).toMatchObject({
      kind: "granted",
      partition: api,
      scope: renamed.scope,
    });
    expect(deps.repositories.resolve).not.toHaveBeenCalled();
    expect(deps.repositoryGrants.ungrantedRepository).toHaveBeenCalledWith(
      authorization(["repositories.read"]),
      [api]
    );
  });

  it("does not resolve repository names for callers without read permission", async () => {
    const { policy, deps } = managementPolicy([]);
    const scope = { type: "repository" as const, repoOwner: "acme", repoName: "api" };
    expect(outcome(await policy.authorizeScope(scope, "read"))).toBe("forbidden");
    expect(deps.repositories.resolve).not.toHaveBeenCalled();
  });

  it("returns environment admission denials unchanged", async () => {
    const { policy, deps } = managementPolicy(["environments.settings.manage"]);
    deps.environments.evaluate.mockResolvedValueOnce({
      kind: "denied",
      response: { error: "Environment not found" },
      status: 404,
      reasonCode: "environment_not_found",
      reason: "Environment not found",
    });
    const scope = { type: "environment" as const, environmentId: "dev" };
    expect(outcome(await policy.authorizeScope(scope, "read"))).toBe("not_found");
    expect(await policy.authorizeScope(scope, "write")).toEqual({
      kind: "granted",
      partition: dev,
      scope,
      canManage: true,
    });
  });
});
