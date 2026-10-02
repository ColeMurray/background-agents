import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { EnvironmentStore } from "../../src/db/environments";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { SessionIndexStore } from "../../src/db/session-index";
import * as repositoryResolution from "../../src/repos/resolve";
import * as routeShared from "../../src/routes/shared";
import * as integrationSettings from "../../src/session/integration-settings-resolution";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
  routeRequest,
  seedMessage,
  seedSandboxAuth,
  serviceFetch,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";
import {
  assignCustomRole,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";
import { getUserEnvVars } from "./session-do-access";

const BASE = "https://test.local";
const MEMBER = "22222222222222222222222222222222";
const TEAM_A = "team_a";
const TEAM_B = "team_b";
const TEAM_ENV = "env_team_a";
const WORKSPACE_ENV = "env_workspace";
const WEB = { repoOwner: "acme/group", repoName: "web", repoId: 1 };
const BASE_BRANCH = "main";
const store = new SessionIndexStore(env.DB);

function createSession(body: object) {
  return ownershipRequest("/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "Environment launch",
      model: "anthropic/claude-haiku-4-5",
      ...body,
    }),
    as: { userId: MEMBER, role: "member" },
  });
}

async function sandboxParent(
  environmentId: string,
  ownerTeamId: string | null,
  visibility: SessionVisibility = "workspace"
) {
  const parent = await initSession({
    sessionName: `ownership-parent-${crypto.randomUUID()}`,
    ...WEB,
    defaultBranch: BASE_BRANCH,
    environmentId,
    userId: MEMBER,
    scmLogin: "environment-member",
  });
  await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = ? WHERE id = ?")
    .bind(ownerTeamId, visibility, parent.sessionName)
    .run();
  const sandboxToken = `sandbox-${crypto.randomUUID()}`;
  await seedSandboxAuth(parent.stub, {
    authToken: sandboxToken,
    sandboxId: `sb-${parent.sessionName}`,
  });
  const [owner] = await queryDO<{ id: string }>(
    parent.stub,
    "SELECT id FROM participants WHERE role = 'owner'"
  );
  if (!owner) throw new Error("Expected parent owner participant");
  await seedMessage(parent.stub, {
    id: `processing-${parent.sessionName}`,
    authorId: owner.id,
    content: "Spawn a child",
    source: "web",
    status: "processing",
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
  return {
    ...parent,
    spawn: () =>
      routeRequest(
        new Request(`${BASE}/sessions/${parent.sessionName}/children`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sandboxToken}` },
          body: JSON.stringify({ title: "Inherited target", prompt: "Investigate" }),
        }),
        env,
        createExecutionContext()
      ),
  };
}

async function expectCloneContext(sessionId: string, environmentId: string) {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  expect(
    await queryDO(
      stub,
      "SELECT environment_id AS environmentId, repo_owner AS repoOwner, repo_name AS repoName, repo_id AS repoId FROM session"
    )
  ).toEqual([{ environmentId, ...WEB }]);
  await waitForSandboxStatus(stub, "failed");
  return stub;
}

describe("session environment ownership compatibility", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: MEMBER, role: "member" },
    });
    for (const teamId of [TEAM_A, TEAM_B]) {
      await seedTeam(teamId, [[MEMBER, "member"]]);
      await seedGrant(teamId, "installation");
    }
    await env.DB.prepare(
      "UPDATE user_identities SET provider_login = 'environment-member' WHERE user_id = ? AND provider = 'github'"
    )
      .bind(MEMBER)
      .run();
    const repositories = [
      {
        position: 0,
        repo_owner: WEB.repoOwner,
        repo_name: WEB.repoName,
        repo_id: WEB.repoId,
        base_branch: BASE_BRANCH,
      },
    ];
    await seedEnvironment(TEAM_ENV, TEAM_A, repositories);
    await seedEnvironment(WORKSPACE_ENV, null, repositories);
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repos) =>
        repos.map((repo) => ({
          ...repo,
          repoId: WEB.repoId,
          baseBranch: repo.baseBranch ?? BASE_BRANCH,
        }))
    );
    // Team-owned children re-resolve the parent repository before checking team grants.
    vi.spyOn(routeShared, "resolveRepoOrError").mockResolvedValue({
      ...WEB,
      defaultBranch: BASE_BRANCH,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([{}, { teamId: TEAM_B, visibility: "private" }])(
    "rejects visible team targets for a different destination %j before resolution/writes",
    async (body) => {
      const resolveTarget = vi.spyOn(repositoryResolution, "resolveEnvironmentTarget");
      const response = await createSession({ environmentId: TEAM_ENV, ...body });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
        count: 0,
      });
    }
  );

  it.each([
    [TEAM_ENV, TEAM_A, "private"],
    [WORKSPACE_ENV, null, "workspace"],
    [WORKSPACE_ENV, TEAM_A, "team"],
    [WORKSPACE_ENV, TEAM_B, "team"],
  ] as const)(
    "admits use-only launch of %s into %s/%s and persists scope",
    async (environmentId, teamId, visibility) => {
      await assignCustomRole(MEMBER, ["sessions.create", "environments.use"]);
      const read = await serviceFetch(`${BASE}/environments/${environmentId}`, {
        as: { userId: MEMBER, role: "member" },
      });
      expect(read.status).toBe(403);
      const response = await createSession({ environmentId, teamId, visibility });
      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await store.get(sessionId)).toMatchObject({
        ownerTeamId: teamId,
        visibility,
        environmentId,
        userId: MEMBER,
      });
      expect(repositoryResolution.resolveSessionRepositories).toHaveBeenCalledTimes(1);
      await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
    }
  );

  it("conceals a nonmember's environment like missing before destination mismatch", async () => {
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM_A, MEMBER)
      .run();
    const resolveTarget = vi.spyOn(repositoryResolution, "resolveEnvironmentTarget");
    for (const environmentId of [TEAM_ENV, "env_missing"]) {
      const response = await createSession({ environmentId, teamId: TEAM_B });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Environment not found" });
    }
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 0,
    });
  });

  it("rejects incompatible sandbox inheritance before settings, child writes or leases", async () => {
    const parent = await sandboxParent(TEAM_ENV, TEAM_B, "private");
    const settings = vi.spyOn(integrationSettings, "resolveSandboxSettings");
    const response = await parent.spawn();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "environment_team_mismatch",
      reason_code: "environment_team_mismatch",
    });
    expect(settings).not.toHaveBeenCalled();
    expect(await store.countTotalChildren(parent.sessionName)).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM child_admission_leases").first()
    ).toEqual({ count: 0 });
  });

  it.each([
    [TEAM_ENV, TEAM_A, "private"],
    [WORKSPACE_ENV, null, "workspace"],
    [WORKSPACE_ENV, TEAM_B, "team"],
  ] as const)(
    "inherits %s into %s/%s without human use access",
    async (environmentId, ownerTeamId, visibility) => {
      const parent = await sandboxParent(environmentId, ownerTeamId, visibility);
      await env.DB.prepare("DELETE FROM team_memberships WHERE user_id = ?").bind(MEMBER).run();
      await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
        .bind(BUILT_IN_ROLE_REGISTRY.viewer.id, MEMBER)
        .run();
      const response = await parent.spawn();
      expect(response.status).toBe(201);
      expect(routeShared.resolveRepoOrError).toHaveBeenCalledTimes(ownerTeamId ? 1 : 0);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await store.get(sessionId)).toMatchObject({
        parentSessionId: parent.sessionName,
        ownerTeamId,
        visibility,
        environmentId,
        repoOwner: WEB.repoOwner,
        repoName: WEB.repoName,
        baseBranch: BASE_BRANCH,
      });
      await expectCloneContext(sessionId, environmentId);
    }
  );

  it.each(["missing", "deleted"])(
    "preserves %s provenance and clone context without target secrets",
    async (state) => {
      const environmentId = state === "deleted" ? TEAM_ENV : "env_missing";
      const key = env.REPO_SECRETS_ENCRYPTION_KEY!;
      await new EnvironmentSecretsStore(env.DB, key).setSecrets(TEAM_ENV, {
        ENV_ONLY: "environment",
      });
      await new RepoSecretsStore(env.DB, key).setSecrets(WEB.repoId, WEB.repoOwner, WEB.repoName, {
        REPO_ONLY: "repository",
      });
      const parent = await sandboxParent(environmentId, TEAM_A);
      if (state === "deleted") await new EnvironmentStore(env.DB).delete(environmentId);
      const response = await parent.spawn();
      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await store.get(sessionId)).toMatchObject({ environmentId, ownerTeamId: TEAM_A });
      expect(routeShared.resolveRepoOrError).toHaveBeenCalledOnce();
      const stub = await expectCloneContext(sessionId, environmentId);
      const secrets = (await getUserEnvVars(stub)) ?? {};
      expect(secrets).not.toHaveProperty("ENV_ONLY");
      expect(secrets).not.toHaveProperty("REPO_ONLY");
    }
  );
});
