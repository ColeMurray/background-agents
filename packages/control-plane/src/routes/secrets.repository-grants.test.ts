import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import {
  authorizationDatabase,
  createRepositoryGrantEnv,
  createRepositoryGrantRequest,
  setupRepositoryGrantSpies,
} from "./repository-grants.test-support";
import { AuthorizationStore } from "../db/authorization-store";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type * as SourceControlModule from "../source-control";
import type { Env } from "../types";
import { secretsRoutes } from "./secrets";

const mocks = vi.hoisted(() => ({ checkRepositoryAccess: vi.fn() }));
vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: () => ({
    name: "github",
    checkRepositoryAccess: mocks.checkRepositoryAccess,
  }),
}));

const env = () => createRepositoryGrantEnv(["repositories.secrets.manage"]);
const request = createRepositoryGrantRequest(secretsRoutes, env);
const repositorySecretRequests = [
  ["GET", "/repos/acme/repo/secrets", undefined],
  ["PUT", "/repos/acme/repo/secrets", { secrets: { KEY: "value" } }],
  ["DELETE", "/repos/acme/repo/secrets/KEY", undefined],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  setupRepositoryGrantSpies();
  mocks.checkRepositoryAccess.mockResolvedValue({
    repoId: 123,
    repoOwner: "acme",
    repoName: "repo",
    defaultBranch: "main",
  });
  vi.spyOn(RepoSecretsStore.prototype, "setSecrets").mockResolvedValue({
    keys: ["KEY"],
    created: 1,
    updated: 0,
  });
  vi.spyOn(RepoSecretsStore.prototype, "listSecretKeys").mockResolvedValue([]);
  vi.spyOn(RepoSecretsStore.prototype, "deleteSecret").mockResolvedValue(true);
  vi.spyOn(GlobalSecretsStore.prototype, "listSecretKeys").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("repository secret source grants", () => {
  it.each(repositorySecretRequests)(
    "denies %s source access for a granted member who is not a lead",
    async (method, path, body) => {
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "team-1",
      ]);
      expect((await request(path, method, body)).status).toBe(403);
      expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
      expect(RepoSecretsStore.prototype.setSecrets).not.toHaveBeenCalled();
      expect(RepoSecretsStore.prototype.deleteSecret).not.toHaveBeenCalled();
    }
  );

  it("denies an active lead without a covering source grant", async () => {
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
      new Map([["team-1", "lead"]])
    );
    expect((await request("/repos/acme/repo/secrets", "GET")).status).toBe(403);
    expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
  });

  it.each(repositorySecretRequests)(
    "allows %s for an owning-team lead without adding repositories.use",
    async (method, path, body) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
        new Map([["team-1", "lead"]])
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([
        "other-team",
        "team-1",
      ]);
      expect((await request(path, method, body)).status).toBe(200);
    }
  );

  it("retains repositories.secrets.manage admission before grants", async () => {
    const environment = env();
    environment.DB = authorizationDatabase({ permissions: [] });
    expect((await request("/repos/acme/repo/secrets", "GET", undefined, environment)).status).toBe(
      403
    );
    expect(mocks.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).not.toHaveBeenCalled();
  });
});

describe.each(["off", "shadow", "on"] as const)(
  "workspace repository secret ownership in %s mode",
  (mode) => {
    let environment: Env;
    beforeEach(() => {
      environment = env();
      environment.TEAMS_ENFORCEMENT = mode;
    });

    it.each(repositorySecretRequests)(
      "allows secret %s with no grants anywhere and only existing permissions",
      async (method, path, body) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
        vi.mocked(TeamRepositoryGrantStore.prototype.listTeamsForRepository).mockResolvedValue([]);
        expect((await request(path, method, body, environment)).status).toBe(200);
        expect(TeamRepositoryGrantStore.prototype.listTeamsForRepository).toHaveBeenCalledWith(123);
      }
    );

    it.each(["member", "lead", null] as const)(
      "denies another team's repositories for an unrelated %s across secret routes",
      async (role) => {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(
          role === null ? new Map() : new Map([["team-1", role]])
        );
        for (const [method, path, body] of repositorySecretRequests) {
          expect((await request(path, method, body, environment)).status).toBe(403);
        }
        expect(RepoSecretsStore.prototype.listSecretKeys).not.toHaveBeenCalled();
        expect(RepoSecretsStore.prototype.setSecrets).not.toHaveBeenCalled();
        expect(RepoSecretsStore.prototype.deleteSecret).not.toHaveBeenCalled();
      }
    );
  }
);

describe.each(["owner", "administrator"] as const)(
  "built-in %s repository secret authorization",
  (key) => {
    beforeEach(() => {
      vi.spyOn(AuthorizationStore.prototype, "getEffectiveAuthorization").mockResolvedValue({
        userId: "user-1",
        suspendedAt: null,
        role: { ...BUILT_IN_ROLE_REGISTRY[key], name: key },
      });
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    });

    it.each(repositorySecretRequests)(
      "allows secret %s for another team's repository without lead membership",
      async (method, path, body) => {
        expect((await request(path, method, body)).status).toBe(200);
      }
    );
  }
);
