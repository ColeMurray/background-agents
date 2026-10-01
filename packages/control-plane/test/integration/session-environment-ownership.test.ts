import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { EnvironmentStore } from "../../src/db/environments";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import * as repositoryResolution from "../../src/repos/resolve";
import * as sessionIdentity from "../../src/session/identity";
import * as integrationSettings from "../../src/session/integration-settings-resolution";
import * as sessionInitialization from "../../src/session/initialize";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
  routeRequest,
  seedMessage,
  seedSandboxAuth,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";
import { getUserEnvVars } from "./session-do-access";

const BASE = "https://test.local";
const MEMBER = "22222222222222222222222222222222";
const TEAM_A = "team_a";
const TEAM_B = "team_b";
const TEAM_ENV = "env_team_a";
const WORKSPACE_ENV = "env_workspace";
const WEB = { repoOwner: "acme/group", repoName: "web", repoId: 1, baseBranch: "main" };

async function createSession(body: object) {
  const url = `${BASE}/sessions`;
  const init = {
    method: "POST",
    body: JSON.stringify({
      title: "Environment launch",
      model: "anthropic/claude-haiku-4-5",
      ...body,
    }),
    as: { userId: MEMBER, role: "member" as const },
  };
  return routeRequest(
    new Request(url, {
      method: init.method,
      body: init.body,
      headers: await serviceRequestHeaders(url, init),
    }),
    env,
    createExecutionContext()
  );
}

async function seedEnvironment(id: string, ownerTeamId: string | null) {
  await new EnvironmentStore(env.DB).create(
    {
      id,
      owner_team_id: ownerTeamId,
      name: id,
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    },
    [
      {
        position: 0,
        repo_owner: WEB.repoOwner,
        repo_name: WEB.repoName,
        repo_id: WEB.repoId,
        base_branch: WEB.baseBranch,
      },
    ]
  );
}

async function sandboxParent(
  environmentId: string,
  ownerTeamId: string | null,
  visibility: SessionVisibility = "workspace"
) {
  const parent = await initSession({
    sessionName: `ownership-parent-${crypto.randomUUID()}`,
    repoOwner: WEB.repoOwner,
    repoName: WEB.repoName,
    repoId: WEB.repoId,
    defaultBranch: WEB.baseBranch,
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

describe("session environment ownership compatibility", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: MEMBER, role: "member" },
    });
    for (const teamId of [TEAM_A, TEAM_B]) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO teams (id, slug, name, default_visibility, created_at, updated_at) VALUES (?, ?, ?, 'team', 1, 1)"
        ).bind(teamId, teamId, teamId),
        env.DB.prepare(
          "INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at) VALUES (?, ?, 'installation', 1)"
        ).bind(`grant-${teamId}`, teamId),
      ]);
      await new TeamMembershipStore(env.DB).add(teamId, MEMBER);
    }
    await env.DB.prepare(
      "UPDATE user_identities SET provider_login = 'environment-member' WHERE user_id = ? AND provider = 'github'"
    )
      .bind(MEMBER)
      .run();
    await seedEnvironment(TEAM_ENV, TEAM_A);
    await seedEnvironment(WORKSPACE_ENV, null);
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((repo) => ({
          ...repo,
          repoId: WEB.repoId,
          baseBranch: repo.baseBranch ?? WEB.baseBranch,
        }))
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { destination: "default workspace", body: {} },
    { destination: "explicit null team", body: { teamId: null } },
    { destination: "workspace without team", body: { visibility: "workspace" } },
    { destination: "private without team", body: { visibility: "private" } },
    { destination: "other team", body: { teamId: TEAM_B } },
    {
      destination: "other team's private session",
      body: { teamId: TEAM_B, visibility: "private" },
    },
  ])(
    "rejects a member of both teams launching a team environment into $destination",
    async ({ body }) => {
      const resolveTarget = vi.spyOn(repositoryResolution, "resolveEnvironmentTarget");
      const enrich = vi.spyOn(sessionIdentity, "resolveGitHubEnrichmentForRequest");
      const settings = vi.spyOn(integrationSettings, "resolveSessionScopedSettings");
      const initialize = vi.spyOn(sessionInitialization, "initializeSession");
      const createIndex = vi.spyOn(SessionIndexStore.prototype, "create");

      const response = await createSession({ environmentId: TEAM_ENV, ...body });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
      expect(enrich).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(createIndex).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
        count: 0,
      });
    }
  );

  it.each([undefined, "team", "private", "workspace"] as const)(
    "allows a matching team environment with visibility %s",
    async (visibility) => {
      const response = await createSession({ environmentId: TEAM_ENV, teamId: TEAM_A, visibility });

      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
        ownerTeamId: TEAM_A,
        visibility: visibility ?? "team",
        environmentId: TEAM_ENV,
        userId: MEMBER,
      });
      await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
    }
  );

  it.each([null, TEAM_A, TEAM_B])(
    "allows a workspace environment into session team %s",
    async (teamId) => {
      const response = await createSession({ environmentId: WORKSPACE_ENV, teamId });

      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
        ownerTeamId: teamId,
        visibility: teamId === null ? "workspace" : "team",
        environmentId: WORKSPACE_ENV,
      });
      await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
    }
  );

  it.each([undefined, TEAM_B])(
    "hides a nonmember environment before destination mismatch (%s)",
    async (teamId) => {
      await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
        .bind(TEAM_A, MEMBER)
        .run();
      const resolveTarget = vi.spyOn(repositoryResolution, "resolveEnvironmentTarget");
      const initialize = vi.spyOn(sessionInitialization, "initializeSession");
      const hidden = await createSession({ environmentId: TEAM_ENV, teamId });
      const missing = await createSession({ environmentId: "env_missing", teamId });

      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      await expect(hidden.json()).resolves.toEqual({ error: "Environment not found" });
      await expect(missing.json()).resolves.toEqual({ error: "Environment not found" });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
        count: 0,
      });
    }
  );

  it.each([
    { ownerTeamId: null, visibility: "workspace" as const },
    { ownerTeamId: null, visibility: "private" as const },
    { ownerTeamId: TEAM_B, visibility: "team" as const },
  ])(
    "rejects sandbox inheritance from a team environment into $ownerTeamId/$visibility",
    async ({ ownerTeamId, visibility }) => {
      const parent = await sandboxParent(TEAM_ENV, ownerTeamId, visibility);
      const settings = vi.spyOn(integrationSettings, "resolveSandboxSettings");
      const initialize = vi.spyOn(sessionInitialization, "initializeSession");
      const createIndex = vi.spyOn(SessionIndexStore.prototype, "create");

      const response = await parent.spawn();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
      expect(settings).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(createIndex).not.toHaveBeenCalled();
      expect(await new SessionIndexStore(env.DB).countTotalChildren(parent.sessionName)).toBe(0);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM child_admission_leases").first()
      ).toEqual({ count: 0 });
    }
  );

  it.each([
    { environmentId: TEAM_ENV, ownerTeamId: TEAM_A, visibility: "team" as const },
    { environmentId: TEAM_ENV, ownerTeamId: TEAM_A, visibility: "private" as const },
    { environmentId: TEAM_ENV, ownerTeamId: TEAM_A, visibility: "workspace" as const },
    { environmentId: WORKSPACE_ENV, ownerTeamId: null, visibility: "workspace" as const },
    { environmentId: WORKSPACE_ENV, ownerTeamId: TEAM_B, visibility: "team" as const },
  ])(
    "allows compatible sandbox inheritance of $environmentId into $ownerTeamId/$visibility without human use access",
    async ({ environmentId, ownerTeamId, visibility }) => {
      const parent = await sandboxParent(environmentId, ownerTeamId, visibility);
      await env.DB.prepare("DELETE FROM team_memberships WHERE user_id = ?").bind(MEMBER).run();
      await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
        .bind(BUILT_IN_ROLE_REGISTRY.viewer.id, MEMBER)
        .run();

      const response = await parent.spawn();

      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
        parentSessionId: parent.sessionName,
        ownerTeamId,
        visibility,
        environmentId,
        repoOwner: WEB.repoOwner,
        repoName: WEB.repoName,
        baseBranch: WEB.baseBranch,
      });
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      expect(
        await queryDO(stub, "SELECT environment_id, repo_owner, repo_name, repo_id FROM session")
      ).toEqual([
        {
          environment_id: environmentId,
          repo_owner: WEB.repoOwner,
          repo_name: WEB.repoName,
          repo_id: WEB.repoId,
        },
      ]);
      await waitForSandboxStatus(stub, "failed");
    }
  );

  it.each(["missing", "deleted"] as const)(
    "preserves sandbox clone context for a %s environment without target secrets",
    async (state) => {
      const environmentId = state === "deleted" ? TEAM_ENV : "env_missing";
      const key = env.REPO_SECRETS_ENCRYPTION_KEY as string;
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
      expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
        environmentId,
        ownerTeamId: TEAM_A,
      });
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      expect(
        await queryDO(stub, "SELECT environment_id, repo_owner, repo_name, repo_id FROM session")
      ).toEqual([
        {
          environment_id: environmentId,
          repo_owner: WEB.repoOwner,
          repo_name: WEB.repoName,
          repo_id: WEB.repoId,
        },
      ]);
      const secrets = (await getUserEnvVars(stub)) ?? {};
      expect(secrets).not.toHaveProperty("ENV_ONLY");
      expect(secrets).not.toHaveProperty("REPO_ONLY");
      await waitForSandboxStatus(stub, "failed");
    }
  );
});
