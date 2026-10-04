import { describe, expect, it, vi } from "vitest";
import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { EnvironmentRow } from "../db/environments";
import type { MemoryPartition } from "../memory/partition";
import type { MemoryRecord } from "../memory/types";
import {
  MemoryManagementPolicy,
  SharedMemoryAccess,
  type MemoryManagementDecision,
  type MemoryManagementPolicyDeps,
  type SharedMemoryAccessDeps,
} from "./memory-access";
import { AuthorizationError } from "./service";

const USER = "11111111111111111111111111111111";
const api: MemoryPartition = { type: "repository", repoId: 1, repoOwner: "acme", repoName: "api" };
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

const ungranted = { owner: "acme", name: "api", repoId: 1 };

function sharedAccess(overrides: Partial<SharedMemoryAccessDeps> = {}) {
  const deps = {
    teams: { isActive: vi.fn(async () => true) },
    grants: { covers: vi.fn<SharedMemoryAccessDeps["grants"]["covers"]>(async () => true) },
    environments: {
      getById: vi.fn(async (id: string) =>
        id === "dev" ? ({ id, owner_team_id: "team" } as EnvironmentRow) : null
      ),
    },
    authorization: { getEffectiveAuthorization: vi.fn(async () => authorization()) },
    repositoryGrants: {
      ungrantedRepository: vi.fn<SharedMemoryAccessDeps["repositoryGrants"]["ungrantedRepository"]>(
        async () => null
      ),
    },
  };
  return { deps, access: new SharedMemoryAccess({ ...deps, ...overrides }) };
}

describe("SharedMemoryAccess", () => {
  it("checks team activity and grant coverage for team sessions", async () => {
    const { access, deps } = sharedAccess();
    const team = await access.forPrincipal({ userId: USER, ownerTeamId: "team" });
    expect(await team.canRead([api, dev, personal])).toBe(true);
    expect(deps.grants.covers).toHaveBeenCalledWith("team", [1]);
    expect(deps.authorization.getEffectiveAuthorization).not.toHaveBeenCalled();
    deps.grants.covers.mockResolvedValueOnce(false);
    expect(await team.canRead([api])).toBe(false);
    deps.teams.isActive.mockResolvedValueOnce(false);
    expect(await team.canRead([personal])).toBe(false);
  });

  it("evaluates workspace sessions as their owner, loading authorization once", async () => {
    const { access, deps } = sharedAccess();
    const owner = await access.forPrincipal({ userId: USER, ownerTeamId: null });
    expect(await owner.canRead([api])).toBe(true);
    deps.repositoryGrants.ungrantedRepository.mockResolvedValueOnce(ungranted);
    expect(await owner.canRead([api])).toBe(false);
    expect(deps.authorization.getEffectiveAuthorization).toHaveBeenCalledTimes(1);
    expect(deps.repositoryGrants.ungrantedRepository).toHaveBeenCalledWith(authorization(), [
      { owner: "acme", name: "api", repoId: 1 },
    ]);
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
    const { access } = sharedAccess({ authorization: { getEffectiveAuthorization: load } });
    const owner = await access.forPrincipal({ userId: USER, ownerTeamId: null });
    expect(await owner.canRead([])).toBe(false);
  });

  it("denies environments that are missing or owned by another team", async () => {
    const { access } = sharedAccess();
    const otherTeam = await access.forPrincipal({ userId: USER, ownerTeamId: "other" });
    expect(await otherTeam.canRead([dev])).toBe(false);
    const team = await access.forPrincipal({ userId: USER, ownerTeamId: "team" });
    expect(await team.canRead([{ type: "environment", environmentId: "gone" }])).toBe(false);
  });

  it("omits unreadable or unidentified targets instead of rejecting the session", async () => {
    const { access, deps } = sharedAccess();
    deps.grants.covers.mockImplementation(async (_team, ids) => !ids.includes(2));
    const target = await access.authorizeTarget({
      userId: USER,
      ownerTeamId: "other",
      repositories: [
        { repoOwner: "acme", repoName: "api", repoId: 1 },
        { repoOwner: "acme", repoName: "web", repoId: 2 },
        { repoOwner: "acme", repoName: "legacy", repoId: null },
      ],
      environmentId: "dev",
    });
    expect(target).toEqual({
      userId: USER,
      repositories: [{ repoOwner: "acme", repoName: "api", repoId: 1 }],
      environmentId: null,
    });
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

const recordIn = (partition: MemoryPartition) => ({ partition }) as MemoryRecord;
/** The denial reason, or "granted". */
const outcome = (decision: MemoryManagementDecision) =>
  decision.kind === "denied" ? decision.denial.reason : decision.kind;

describe("MemoryManagementPolicy", () => {
  it("keeps personal memory owner-only and requires the personal permission", async () => {
    const { policy } = managementPolicy(["memories.manage_own"]);
    expect(await policy.authorize({ type: "personal" }, "write")).toEqual({
      kind: "granted",
      partition: personal,
      canManage: true,
    });
    const other = recordIn({ type: "personal", userId: "someone-else" });
    expect(outcome(await policy.authorize({ type: "personal" }, "read", other))).toBe("not_found");
    const { policy: noPermission } = managementPolicy([]);
    expect(outcome(await noPermission.authorize({ type: "personal" }, "read"))).toBe("forbidden");
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
    expect(await policy.authorize(scope, "read")).toEqual({
      kind: "granted",
      partition: api,
      canManage: false,
    });
    expect(await policy.authorize(scope, "write")).toEqual({
      kind: "denied",
      denial: { reason: "forbidden", message: "Repository memory management permission required" },
    });
  });

  it("reports the repository that failed its grant check", async () => {
    const { policy, deps } = managementPolicy(["repositories.read"]);
    deps.repositoryGrants.ungrantedRepository.mockResolvedValueOnce(ungranted);
    expect(
      await policy.authorize({ type: "repository", repoOwner: "acme", repoName: "api" }, "read")
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

  it("conceals records whose stored ID differs from the repository now using the name", async () => {
    const { policy } = managementPolicy(["repositories.read"]);
    const reused = recordIn({ ...api, repoId: 99 });
    const scope = { type: "repository" as const, repoOwner: "acme", repoName: "api" };
    expect(outcome(await policy.authorize(scope, "read", reused))).toBe("not_found");
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
    expect(outcome(await policy.authorize(scope, "read"))).toBe("not_found");
    expect(await policy.authorize(scope, "write")).toEqual({
      kind: "granted",
      partition: dev,
      canManage: true,
    });
  });
});
