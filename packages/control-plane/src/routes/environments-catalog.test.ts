import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import * as requestAudit from "../authorization/request-audit";
import { AuthorizationStore } from "../db/authorization-store";
import {
  EnvironmentStore,
  toEnvironment,
  type EnvironmentRepositoryRow,
  type EnvironmentRow,
} from "../db/environments";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import * as sourceControl from "../source-control";
import type { Env } from "../types";
import { environmentRoutes } from "./environments";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const TEAM_ID = "team_selected";
const targets: [string, (number | null)[]][] = [
  ["covered", [1]],
  ["denied", [2]],
  ["multi", [1, 2]],
  ["nullable", [null]],
  ["empty", []],
];
const catalog: EnvironmentRow[] = targets.map(([name]) => ({
  id: `env_${name}`,
  owner_team_id: null,
  name,
  description: null,
  prebuild_enabled: 0,
  channel_associations: null,
  created_at: 1,
  updated_at: 1,
}));
const repositoriesById = new Map<string, EnvironmentRepositoryRow[]>(
  targets.map(([name, repoIds]) => [
    `env_${name}`,
    repoIds.map((repoId, position) => ({
      environment_id: `env_${name}`,
      position,
      repo_owner: "acme",
      repo_name: `repo-${repoId ?? 1}`,
      repo_id: repoId,
      base_branch: "main",
    })),
  ])
);
const fullCatalog = catalog.map((row) => toEnvironment(row, repositoriesById.get(row.id) ?? []));
const handleRequest = createTestRequestHandler([environmentRoutes]);
let environment: Env;

function list(query = "?teamId=team_selected"): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local/environments${query}`),
    environment,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("environment catalog team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    environment = createTestEnv({
      DB: authorizationDatabase({ permissions: ["environments.read"] }),
    });
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockResolvedValue(
      new Map([[TEAM_ID, "member"]])
    );
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 1 },
    ]);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository");
    vi.spyOn(EnvironmentStore.prototype, "list").mockResolvedValue({
      environments: catalog,
      total: catalog.length,
    });
    vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironmentIds").mockResolvedValue(
      repositoriesById
    );
    vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment");
    vi.spyOn(requestAudit, "auditRouteAuthorizationDecision").mockResolvedValue(undefined);
    vi.spyOn(sourceControl, "createSourceControlProviderFromEnv").mockImplementation(() => {
      throw new Error("Catalog listing must not resolve SCM repositories");
    });
  });
  afterEach(() => {
    expect(sourceControl.createSourceControlProviderFromEnv).not.toHaveBeenCalled();
    expect(EnvironmentStore.prototype.getRepositoriesForEnvironment).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([null, TEAM_ID, "team_other"])(
    "returns only fully covered targets, regardless of environment owner %s",
    async (ownerTeamId) => {
      vi.mocked(EnvironmentStore.prototype.list).mockResolvedValue({
        environments: catalog.map((row) => ({ ...row, owner_team_id: ownerTeamId })),
        total: catalog.length,
      });

      const response = await list();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ environments: [fullCatalog[0]], total: 1 });
      expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledWith("user-1");
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
        TEAM_ID
      );
      expect(
        EnvironmentStore.prototype.getRepositoriesForEnvironmentIds
      ).toHaveBeenCalledExactlyOnceWith(catalog.map((row) => row.id));
      expect(requestAudit.auditRouteAuthorizationDecision).not.toHaveBeenCalled();
    }
  );

  it("includes a multi-repository target only when every numeric ID is granted", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 1 },
      { grant_kind: "repository", repo_external_id: 2 },
    ]);

    expect(await (await list()).json()).toEqual({
      environments: fullCatalog.slice(0, 3),
      total: 3,
    });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledOnce();
  });

  it("returns all nonempty targets, including nullable IDs, for an installation grant", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);

    expect(await (await list()).json()).toEqual({
      environments: fullCatalog.slice(0, 4),
      total: 4,
    });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledOnce();
  });

  it("returns an empty catalog when the team has no grants", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([]);

    expect(await (await list()).json()).toEqual({ environments: [], total: 0 });
  });

  it.each(["", "?teamId="])("preserves the full workspace catalog for %s", async (query) => {
    expect(await (await list(query)).json()).toEqual({
      environments: fullCatalog,
      total: catalog.length,
    });
    expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it.each([TEAM_ID, "team_missing"])(
    "conceals and audits nonmember or missing team %s identically",
    async (teamId) => {
      vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(teamId === TEAM_ID);
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([["team_other", "lead"]])
      );

      const response = await list(`?teamId=${teamId}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Team not found" });
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
      expect(requestAudit.auditRouteAuthorizationDecision).toHaveBeenCalledExactlyOnceWith({
        ctx: expect.anything(),
        method: "GET",
        path: "/environments",
        response,
        teamId,
        decision: {
          kind: "denied",
          reasonCode: "team_not_visible",
          reason: "Team not found",
          requirements: [{ kind: "team", teamIdParam: "teamId", need: "member" }],
          effectivePermissions: [],
        },
      });
    }
  );

  it.each(["owner", "administrator"] as const)(
    "allows built-in %s without membership but still applies the team's grants",
    async (key) => {
      vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
        userId: "user-1",
        suspendedAt: null,
        role: { ...BUILT_IN_ROLE_REGISTRY[key], name: key },
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());

      expect(await (await list()).json()).toEqual({ environments: [fullCatalog[0]], total: 1 });
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();

      vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);
      const archivedResponse = await list();
      expect(archivedResponse.status).toBe(404);
      expect(await archivedResponse.json()).toEqual({ error: "Team not found" });
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledOnce();
    }
  );

  it("conceals an archived team even from its members", async () => {
    vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);

    const response = await list();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Team not found" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
  });

  it.each(["", "?teamId=team_selected"])(
    "retains environments.read admission for %s",
    async (query) => {
      environment.DB = authorizationDatabase({ permissions: ["repositories.use"] });

      const response = await list(query);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Forbidden",
        code: "permission_required",
        permission: "environments.read",
      });
      expect(TeamStore.prototype.isActive).not.toHaveBeenCalled();
      expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
    }
  );

  it.each(["slack-bot", "linear-bot"] as const)(
    "preserves actorless %s workspace access but conceals an opaque team scope",
    async (service) => {
      mocks.authenticate.mockImplementation(async (request: Request) => ({
        principal: { kind: "service", service, actor: null },
        request,
      }));

      expect(await (await list("")).json()).toEqual({
        environments: fullCatalog,
        total: catalog.length,
      });
      vi.mocked(EnvironmentStore.prototype.list).mockClear();
      const response = await list();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Team not found" });
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
      expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
      expect(requestAudit.auditRouteAuthorizationDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/environments",
          teamId: TEAM_ID,
          decision: expect.objectContaining({ reasonCode: "team_not_visible" }),
        })
      );
    }
  );

  it("scopes an acting service using its canonical actor's actual membership", async () => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: {
        kind: "service",
        service: "slack-bot",
        actor: {
          provider: "slack",
          providerUserId: "U_ACTOR",
          participantUserId: "slack:U_ACTOR",
          canonicalUserId: "user-1",
        },
      },
      request,
    }));

    expect(await (await list()).json()).toEqual({ environments: [fullCatalog[0]], total: 1 });
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledExactlyOnceWith("user-1");
  });
});
