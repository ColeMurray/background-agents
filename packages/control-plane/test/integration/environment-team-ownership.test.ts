import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { Environment } from "@open-inspect/shared/types/environments";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamSettingsStore } from "../../src/db/team-settings";
import { TeamStore } from "../../src/db/teams";
import * as repositoryResolution from "../../src/repos/resolve";
import { cleanD1Tables } from "./cleanup";
import { seedImageRowForScope } from "./image-build-helpers";
import {
  routeRequest,
  serviceRequestHeaders,
  waitForSandboxStatus,
  type ServiceRequestInit,
} from "./helpers";

const BASE = "https://test.local";
const MEMBER = "22222222222222222222222222222222";
const MANAGER_ROLE = "role_environment_manager";
const MANAGER_PERMISSIONS: PermissionId[] = [
  "environments.read",
  "environments.manage",
  "environments.use",
  "environments.secrets.manage",
  "environments.settings.manage",
  "environments.images.manage",
  "integrations.read",
  "image_builds.read",
  "sessions.create",
];
const WEB: EnvironmentRepositoryInsert = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 1,
  base_branch: "main",
};
const API: EnvironmentRepositoryInsert = { ...WEB, position: 1, repo_name: "api", repo_id: 2 };
const CREATE_BODY = {
  name: "Created",
  repositories: [{ repoOwner: "acme/group", repoName: "web" }],
};

async function request(path: string, init: ServiceRequestInit = {}) {
  const url = `${BASE}${path}`;
  return routeRequest(
    new Request(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: await serviceRequestHeaders(url, init),
    }),
    env,
    createExecutionContext()
  );
}

function memberRequest(path: string, method = "GET", body?: object) {
  return request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    as: { userId: MEMBER, role: "member" },
  });
}

function ownerRequest(path: string, method: string, body?: object) {
  return request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function team(slug: string, grantInstallation = true) {
  const row = await new TeamStore(env.DB).create({ slug, name: slug, joinPolicy: "invite_only" });
  if (grantInstallation) {
    await env.DB.prepare(
      "INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at) VALUES (?, ?, 'installation', ?)"
    )
      .bind(crypto.randomUUID(), row.id, Date.now())
      .run();
  }
  return row;
}

async function grantRepository(teamId: string, repo = WEB) {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
       (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, 'repository', ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), teamId, repo.repo_id, repo.repo_owner, repo.repo_name, Date.now())
    .run();
}

async function environment(
  ownerTeamId: string | null,
  name = "Seeded",
  repositories = [WEB],
  prebuildEnabled = false
) {
  const id = `env_${crypto.randomUUID()}`;
  await new EnvironmentStore(env.DB).create(
    {
      id,
      owner_team_id: ownerTeamId,
      name,
      description: null,
      prebuild_enabled: prebuildEnabled ? 1 : 0,
      channel_associations: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    repositories
  );
  return id;
}

describe("environment team ownership", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`);
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: MEMBER, role: "member" },
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO roles (id, key, name, normalized_name, is_system) VALUES (?, NULL, 'Environment Manager', 'environment manager', 0)"
      ).bind(MANAGER_ROLE),
      ...MANAGER_PERMISSIONS.map((permission) =>
        env.DB.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)").bind(
          MANAGER_ROLE,
          permission
        )
      ),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        MANAGER_ROLE,
        MEMBER
      ),
    ]);
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((repo) => ({
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          repoId: repo.repoName === "web" ? 1 : 2,
          baseBranch: repo.baseBranch ?? "main",
        }))
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, null])(
    "creates workspace environments with teamId %s and capabilities",
    async (teamId) => {
      const response = await ownerRequest("/environments", "POST", { ...CREATE_BODY, teamId });
      expect(response.status).toBe(201);
      const { environment: created } = await response.json<{ environment: Environment }>();
      expect(created.ownerTeamId).toBeNull();
      expect(created.capabilities).toEqual({ canRead: true, canManage: true, canUse: true });
    }
  );

  it.each([undefined, null])(
    "requires a team on create when configured, including teamId %s",
    async (teamId) => {
      await new TeamSettingsStore(env.DB).set({ requireTeamOnCreate: true });
      const response = await ownerRequest("/environments", "POST", { ...CREATE_BODY, teamId });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "team_required" });
      expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
    }
  );

  it("allows a granted team lead to create but refuses members and nonmembers with manage permission", async () => {
    const target = await team("creation");
    expect(
      (await memberRequest("/environments", "POST", { ...CREATE_BODY, teamId: target.id })).status
    ).toBe(403);
    await new TeamMembershipStore(env.DB).add(target.id, MEMBER);
    const denied = await memberRequest("/environments", "POST", {
      ...CREATE_BODY,
      teamId: target.id,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "not_owner_or_lead" });
    await new TeamMembershipStore(env.DB).setRole(target.id, MEMBER, "lead");
    const created = await memberRequest("/environments", "POST", {
      ...CREATE_BODY,
      teamId: target.id,
    });
    expect(created.status).toBe(201);
    const { environment: createdEnvironment } = await created.json<{ environment: Environment }>();
    expect(createdEnvironment.ownerTeamId).toBe(target.id);
    expect(createdEnvironment.capabilities).toEqual({
      canRead: true,
      canManage: true,
      canUse: true,
    });
    expect((await memberRequest("/environments", "POST", CREATE_BODY)).status).toBe(403);
  });

  it("refuses missing and archived create teams before repository resolution", async () => {
    expect(
      (await ownerRequest("/environments", "POST", { ...CREATE_BODY, teamId: "team_missing" }))
        .status
    ).toBe(404);
    const target = await team("archived");
    await new TeamStore(env.DB).archive(target.id);
    const response = await ownerRequest("/environments", "POST", {
      ...CREATE_BODY,
      teamId: target.id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason_code: "team_archived" });
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
  });

  it("validates every resolved repository grant on team create", async () => {
    const target = await team("repository-grants", false);
    await grantRepository(target.id);
    const response = await ownerRequest("/environments", "POST", {
      ...CREATE_BODY,
      teamId: target.id,
      repositories: [...CREATE_BODY.repositories, { repoOwner: "acme/group", repoName: "api" }],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/group/api",
    });
    expect((await new EnvironmentStore(env.DB).list()).total).toBe(0);
  });

  it("scopes case-insensitive create and rename uniqueness to the owner team", async () => {
    const first = await team("first");
    const second = await team("second");
    await environment(null, "Taken");
    await environment(first.id, "Taken");
    const response = await ownerRequest("/environments", "POST", {
      ...CREATE_BODY,
      name: "taken",
      teamId: second.id,
    });
    expect(response.status).toBe(201);
    const { environment: created } = await response.json<{ environment: Environment }>();
    expect(
      (
        await ownerRequest("/environments", "POST", {
          ...CREATE_BODY,
          name: "TAKEN",
          teamId: second.id,
        })
      ).status
    ).toBe(409);
    const renamedId = await environment(second.id, "Before");
    expect(
      (await ownerRequest(`/environments/${renamedId}`, "PUT", { name: "Taken" })).status
    ).toBe(409);
    expect(
      (await ownerRequest(`/environments/${created.id}`, "PUT", { name: "TAKEN" })).status
    ).toBe(200);
    expect(
      (await ownerRequest(`/environments/${renamedId}`, "PUT", { name: "Other" })).status
    ).toBe(200);
  });

  it("filters lists by exact teamId and viewer read access with visible totals and capabilities", async () => {
    const visible = await team("visible");
    const hidden = await team("hidden");
    await new TeamMembershipStore(env.DB).add(visible.id, MEMBER);
    const workspaceId = await environment(null, "Workspace");
    const visibleId = await environment(visible.id, "Visible");
    await environment(hidden.id, "Hidden");
    const list = await (
      await memberRequest("/environments")
    ).json<{ environments: Environment[]; total: number }>();
    expect(list.total).toBe(2);
    expect(list.environments.map((row) => row.id).sort()).toEqual([workspaceId, visibleId].sort());
    for (const row of list.environments) {
      expect(row.capabilities).toEqual({ canRead: true, canManage: false, canUse: true });
    }
    expect(await (await memberRequest(`/environments?teamId=${visible.id}`)).json()).toMatchObject({
      total: 1,
      environments: [{ id: visibleId, ownerTeamId: visible.id }],
    });
    expect(await (await memberRequest(`/environments?teamId=${hidden.id}`)).json()).toEqual({
      total: 0,
      environments: [],
    });
    expect(await (await memberRequest("/environments?teamId=null")).json()).toMatchObject({
      total: 1,
      environments: [{ id: workspaceId, ownerTeamId: null }],
    });
    expect(
      (await memberRequest(`/environments?teamId=${visible.id}&teamId=${hidden.id}`)).status
    ).toBe(400);
  });

  it("hides nonmember item reads and mutations and refuses non-lead management", async () => {
    const target = await team("item-access");
    const id = await environment(target.id);
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect(
        (await memberRequest(`/environments/${id}`, method, method === "PUT" ? {} : undefined))
          .status
      ).toBe(404);
    }
    await new TeamMembershipStore(env.DB).add(target.id, MEMBER);
    const read = await memberRequest(`/environments/${id}`);
    expect(read.status).toBe(200);
    const { environment: readable } = await read.json<{ environment: Environment }>();
    expect(readable.capabilities).toEqual({ canRead: true, canManage: false, canUse: true });
    for (const method of ["PUT", "DELETE"]) {
      expect(
        (await memberRequest(`/environments/${id}`, method, method === "PUT" ? {} : undefined))
          .status
      ).toBe(403);
    }
    await new TeamMembershipStore(env.DB).setRole(target.id, MEMBER, "lead");
    expect(
      (await memberRequest(`/environments/${id}`, "PUT", { description: "Updated" })).status
    ).toBe(200);
    expect((await memberRequest(`/environments/${id}`, "DELETE")).status).toBe(200);
  });

  it("denies reads without read permission while preserving independent manage and use capabilities", async () => {
    const target = await team("independent");
    await new TeamMembershipStore(env.DB).add(target.id, MEMBER, "lead");
    const id = await environment(target.id);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = 'environments.read'"
    )
      .bind(MANAGER_ROLE)
      .run();
    for (const path of [
      `/environments/${id}`,
      `/environments/${id}/secrets`,
      `/integration-settings/sandbox/environments/${id}`,
    ]) {
      const denied = await memberRequest(path);
      expect(denied.status, path).toBe(403);
      expect(await denied.json()).toMatchObject({ reason_code: "missing_permission" });
    }
    expect((await memberRequest("/environments")).status).toBe(403);
    const updated = await memberRequest(`/environments/${id}`, "PUT", { description: "Managed" });
    expect(updated.status).toBe(200);
    const { environment: updatedEnvironment } = await updated.json<{ environment: Environment }>();
    expect(updatedEnvironment.capabilities).toEqual({
      canRead: false,
      canManage: true,
      canUse: true,
    });
    expect(
      (await memberRequest(`/environments/${id}/secrets`, "PUT", { secrets: { TOKEN: "value" } }))
        .status
    ).toBe(200);
    expect(
      (
        await memberRequest(`/integration-settings/sandbox/environments/${id}`, "PUT", {
          settings: { terminalEnabled: true },
        })
      ).status
    ).toBe(200);
    expect((await memberRequest(`/environments/${id}`, "DELETE")).status).toBe(200);
  });

  it("hides another team's environment on session create without teamId before resolution or index writes", async () => {
    const source = await team("launch-source");
    const other = await team("launch-other");
    await new TeamMembershipStore(env.DB).add(source.id, MEMBER);
    const id = await environment(other.id);
    const resolveTarget = vi.spyOn(repositoryResolution, "resolveEnvironmentTarget");
    const createIndex = vi.spyOn(SessionIndexStore.prototype, "create");

    const response = await memberRequest("/sessions", "POST", {
      title: "Cross-team environment launch",
      environmentId: id,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Environment not found" });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it("lets a member launch a team environment with use permission but no read permission", async () => {
    const target = await team("use-only-launch");
    await new TeamMembershipStore(env.DB).add(target.id, MEMBER);
    const id = await environment(target.id);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM role_permissions WHERE role_id = ? AND permission_id NOT IN ('sessions.create', 'environments.use')"
      ).bind(MANAGER_ROLE),
      env.DB.prepare(
        "UPDATE user_identities SET provider_login = 'environment-member' WHERE user_id = ? AND provider = 'github'"
      ).bind(MEMBER),
    ]);
    const read = await memberRequest(`/environments/${id}`);
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ reason_code: "missing_permission" });

    const response = await memberRequest("/sessions", "POST", {
      title: "Use-only environment launch",
      environmentId: id,
      model: "anthropic/claude-haiku-4-5",
    });

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(repositoryResolution.resolveSessionRepositories).toHaveBeenCalledTimes(1);
    const rows = await env.DB.prepare("SELECT id, user_id, environment_id FROM sessions").all<{
      id: string;
      user_id: string;
      environment_id: string;
    }>();
    expect(rows.results).toEqual([{ id: sessionId, user_id: MEMBER, environment_id: id }]);
    await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
  });

  it("revalidates the final repository set on scalar-only updates and permits repairing revoked grants", async () => {
    const target = await team("revoked", false);
    await grantRepository(target.id);
    const id = await environment(target.id, "Revoked", [WEB, API]);
    const denied = await ownerRequest(`/environments/${id}`, "PUT", {
      description: "Must not save",
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/group/api",
    });
    expect((await new EnvironmentStore(env.DB).getById(id))?.description).toBeNull();
    const repaired = await ownerRequest(`/environments/${id}`, "PUT", {
      repositories: CREATE_BODY.repositories,
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({
      environment: { capabilities: { canManage: true }, repositories: [{ repoId: 1 }] },
    });
  });

  it("requires canonical repository IDs even when a repository grant name matches", async () => {
    const target = await team("numeric-grants", false);
    await grantRepository(target.id, { ...WEB, repo_owner: "ACME/GROUP", repo_name: "WEB" });
    const id = await environment(target.id, "Numeric grants");
    for (const repoId of [null, 99]) {
      await new EnvironmentStore(env.DB).replaceRepositories(id, [{ ...WEB, repo_id: repoId }]);
      const denied = await ownerRequest(`/environments/${id}`, "PUT", { description: "Denied" });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        code: "target_team_missing_grant",
        repository: "acme/group/web",
      });
      expect((await new EnvironmentStore(env.DB).getById(id))?.description).toBeNull();
    }
    const canonical = await ownerRequest(`/environments/${id}`, "PUT", {
      repositories: CREATE_BODY.repositories,
      description: "Canonical",
    });
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toMatchObject({
      environment: { description: "Canonical", repositories: [{ repoId: WEB.repo_id }] },
    });
  });

  it("allows null repository IDs under an installation grant on updates", async () => {
    const target = await team("installation-grant");
    const id = await environment(target.id, "Unresolved", [{ ...WEB, repo_id: null }]);
    expect(
      (await ownerRequest(`/environments/${id}`, "PUT", { description: "Installation-granted" }))
        .status
    ).toBe(200);
    expect(
      (await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id))[0].repo_id
    ).toBeNull();
  });

  it("enforces environment ownership on secrets, settings, and image trigger adjunct routes", async () => {
    const target = await team("adjunct");
    const id = await environment(target.id);
    const paths = [
      ["GET", `/environments/${id}/secrets`, undefined],
      ["PUT", `/environments/${id}/secrets`, { secrets: { TOKEN: "value" } }],
      ["DELETE", `/environments/${id}/secrets/TOKEN`, undefined],
      ["POST", `/environments/${id}/secrets/import`, { repoOwner: "acme/group", repoName: "web" }],
      ["GET", `/integration-settings/sandbox/environments/${id}`, undefined],
      [
        "PUT",
        `/integration-settings/sandbox/environments/${id}`,
        { settings: { terminalEnabled: true } },
      ],
      ["DELETE", `/integration-settings/sandbox/environments/${id}`, undefined],
      ["POST", `/image-builds/trigger/environment/${id}`, undefined],
    ] as const;
    for (const [method, path, body] of paths) {
      expect((await memberRequest(path, method, body)).status, `${method} ${path}`).toBe(404);
    }
    await new TeamMembershipStore(env.DB).add(target.id, MEMBER);
    for (const [method, path, body] of paths) {
      expect((await memberRequest(path, method, body)).status, `${method} ${path}`).toBe(
        method === "GET" ? 200 : 403
      );
    }
    await new TeamMembershipStore(env.DB).setRole(target.id, MEMBER, "lead");
    expect(
      (await memberRequest(`/environments/${id}/secrets`, "PUT", { secrets: { TOKEN: "value" } }))
        .status
    ).toBe(200);
    expect(
      (
        await memberRequest(`/integration-settings/sandbox/environments/${id}`, "PUT", {
          settings: { terminalEnabled: true },
        })
      ).status
    ).toBe(200);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = 'environments.secrets.manage'"
    )
      .bind(MANAGER_ROLE)
      .run();
    expect((await memberRequest(`/environments/${id}/secrets`)).status).toBe(403);
  });

  it("filters environment image status and enabled feeds and hides unauthorized explicit scopes", async () => {
    const visible = await team("images-visible");
    const hidden = await team("images-hidden");
    await new TeamMembershipStore(env.DB).add(visible.id, MEMBER);
    const visibleId = await environment(visible.id, "Visible images", [WEB], true);
    const hiddenId = await environment(hidden.id, "Hidden images", [WEB], true);
    for (const id of [visibleId, hiddenId]) {
      await seedImageRowForScope(
        { kind: "environment", id },
        { id: `image_${id}`, status: "ready" }
      );
    }
    const status = await (
      await memberRequest("/image-builds/status")
    ).json<{ images: { scopeId: string }[] }>();
    expect(status.images.map((row) => row.scopeId)).toEqual([visibleId]);
    const enabled = await (
      await memberRequest("/image-builds/enabled")
    ).json<{ units: { scopeId: string }[] }>();
    expect(enabled.units.map((row) => row.scopeId)).toEqual([visibleId]);
    expect(
      (await memberRequest(`/image-builds/status?scope_kind=environment&scope_id=${hiddenId}`))
        .status
    ).toBe(404);
    expect(
      (await memberRequest(`/image-builds/status?scope_kind=environment&scope_id=${visibleId}`))
        .status
    ).toBe(200);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = 'environments.read'"
    )
      .bind(MANAGER_ROLE)
      .run();
    expect(await (await memberRequest("/image-builds/status")).json()).toEqual({ images: [] });
    expect(await (await memberRequest("/image-builds/enabled")).json()).toMatchObject({
      units: [],
    });
    const forbidden = await memberRequest(
      `/image-builds/status?scope_kind=environment&scope_id=${visibleId}`
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ reason_code: "missing_permission" });
    expect(
      (await memberRequest(`/image-builds/status?scope_kind=environment&scope_id=${hiddenId}`))
        .status
    ).toBe(404);
  });

  it("preserves the actorless service read ceiling", async () => {
    const target = await team("bot-read");
    const id = await environment(target.id);
    for (const service of ["slack-bot", "linear-bot"] as const) {
      const list = await request("/environments", { service });
      expect(list.status).toBe(200);
      const { environments } = await list.json<{ environments: Environment[] }>();
      expect(environments).toHaveLength(1);
      expect(environments[0].id).toBe(id);
      expect(environments[0].capabilities).toEqual({
        canRead: true,
        canManage: false,
        canUse: true,
      });
      expect((await request(`/environments/${id}`, { service })).status).toBe(403);
    }
    expect((await request("/environments", { service: "github-bot" })).status).toBe(403);
    const response = await request(`/environments/${id}`, { service: "github-bot" });
    expect(response.status).toBe(200);
    const { environment: readable } = await response.json<{ environment: Environment }>();
    expect(readable.capabilities).toEqual({ canRead: true, canManage: false, canUse: true });
  });
});
