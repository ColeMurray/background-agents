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
const owner = authorization(["memories.manage_own"]);

function sessionPolicy(overrides: Partial<SessionMemoryAccessPolicyDeps> = {}) {
  const deps = {
    teams: { isActive: vi.fn(async () => true) },
    grants: { covers: vi.fn<SessionMemoryAccessPolicyDeps["grants"]["covers"]>(async () => true) },
    environments: {
      getById: vi.fn(async (id: string) =>
        id === "dev" ? ({ id, owner_team_id: "team" } as EnvironmentRow) : null
      ),
    },
    authorization: { getEffectiveAuthorization: vi.fn(async () => owner) },
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
    expect(await policy.check(team, [api, dev])).toEqual(GRANTED);
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

  it("evaluates workspace sessions as their owner", async () => {
    const { policy, deps } = sessionPolicy();
    expect(await policy.check(workspace, [api])).toEqual(GRANTED);
    deps.repositoryGrants.ungrantedRepository.mockResolvedValueOnce(ungranted);
    expect(await policy.check(workspace, [api])).toEqual({
      kind: "denied",
      reason: "repository_ungranted",
      partition: api,
    });
    expect(deps.repositoryGrants.ungrantedRepository).toHaveBeenCalledWith(owner, [api]);
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

  it("admits a personal store while its owner may manage personal memory", async () => {
    const { policy, deps } = sessionPolicy();
    expect(await policy.check(team, [api, dev, personal])).toEqual(GRANTED);
    expect(await policy.check(workspace, [personal, personal])).toEqual(GRANTED);
    // Once per check (the workspace owner and personal owner are the same user), never reused.
    expect(deps.authorization.getEffectiveAuthorization).toHaveBeenCalledTimes(2);
    expect(deps.authorization.getEffectiveAuthorization).toHaveBeenCalledWith(USER);
  });

  it("observes a revocation between checks by the same policy", async () => {
    const { policy, deps } = sessionPolicy();
    expect(await policy.check(team, [personal])).toEqual(GRANTED);
    deps.authorization.getEffectiveAuthorization.mockResolvedValueOnce(authorization());
    expect(await policy.check(team, [personal])).toMatchObject({ reason: "personal_unavailable" });
  });

  it.each([
    ["lacks memories.manage_own", async () => authorization(["sessions.create"])],
    ["is suspended", async () => authorization(["memories.manage_own"], { suspendedAt: 1 })],
    [
      "has no authorization",
      async () => {
        throw new AuthorizationError(404, "not_found");
      },
    ],
  ])("denies a personal store whose owner %s", async (_case, load) => {
    const { policy } = sessionPolicy({ authorization: { getEffectiveAuthorization: load } });
    expect(await policy.check(team, [api, personal])).toEqual({
      kind: "denied",
      reason: "personal_unavailable",
      partition: personal,
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
      preload: vi.fn(async () => {}),
      evaluate: vi.fn<MemoryManagementPolicyDeps["environments"]["evaluate"]>(async () => ({
        kind: "allowed" as const,
        effectivePermission: null,
        admission: {} as never,
      })),
    },
    repositoryGrants: {
      preload: vi.fn(async () => {}),
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
  it("preloads environments independently of repository read permission", async () => {
    const { policy, deps } = managementPolicy(["repositories.read"]);
    const candidates = [api, dev, personal];
    await policy.authorizeSharedCatalog(candidates);
    expect(deps.repositoryGrants.preload).toHaveBeenCalledWith(
      authorization(["repositories.read"]),
      [api]
    );
    expect(deps.environments.preload).toHaveBeenCalledWith(["dev"]);
    const denied = managementPolicy([]);
    await denied.policy.authorizeSharedCatalog(candidates);
    expect(denied.deps.repositoryGrants.preload).not.toHaveBeenCalled();
    expect(denied.deps.environments.preload).toHaveBeenCalledWith(["dev"]);
  });

  it("returns only readable shared partitions with their management capabilities", async () => {
    const { policy, deps } = managementPolicy([
      "repositories.read",
      "repositories.settings.manage",
      "environments.settings.manage",
      "memories.manage_own",
    ]);
    deps.repositoryGrants.ungrantedRepository.mockImplementation(async (_auth, _repos, options) =>
      options?.requireLead ? ungranted : null
    );
    deps.environments.evaluate.mockImplementation(async (id) =>
      id === "hidden"
        ? {
            kind: "denied",
            response: { error: "Environment not found" },
            status: 404,
            reasonCode: "environment_not_visible",
            reason: "Environment not found",
          }
        : { kind: "allowed", effectivePermission: null, admission: {} as never }
    );
    const result = await policy.authorizeSharedCatalog([
      api,
      dev,
      { type: "environment", environmentId: "hidden" },
      personal,
    ]);
    expect(result).toEqual([
      { partition: api, canManage: false },
      { partition: dev, canManage: true },
    ]);
    expect(deps.environments.preload).toHaveBeenCalledExactlyOnceWith(["dev", "hidden"]);
    expect(deps.repositories.resolve).not.toHaveBeenCalled();
    expect(deps.environments.preload.mock.invocationCallOrder[0]).toBeLessThan(
      deps.environments.evaluate.mock.invocationCallOrder[0]
    );
  });

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

  it("authorizes many records in order over one preloaded snapshot", async () => {
    const { policy, deps } = managementPolicy([
      "memories.manage_own",
      "repositories.read",
      "environments.settings.manage",
    ]);
    const records = [
      recordIn(api, apiScope),
      recordIn(dev),
      recordIn(personal),
      recordIn({ type: "personal", userId: "someone-else" }),
    ];
    const decisions = await policy.authorizeRecords(records, "write");
    // Repository management also needs `repositories.settings.manage`.
    expect(decisions.map(outcome)).toEqual(["forbidden", "granted", "granted", "not_found"]);
    expect(deps.environments.preload).toHaveBeenCalledExactlyOnceWith(["dev"]);
    expect(deps.repositoryGrants.preload).toHaveBeenCalledExactlyOnceWith(deps.authorization, [
      api,
    ]);
    expect(deps.repositoryGrants.preload.mock.invocationCallOrder[0]).toBeLessThan(
      deps.repositoryGrants.ungrantedRepository.mock.invocationCallOrder[0]
    );
    expect(deps.repositories.resolve).not.toHaveBeenCalled();
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
