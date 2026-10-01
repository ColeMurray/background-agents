import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { Environment } from "@open-inspect/shared/types/environments";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamSettingsStore } from "../../src/db/team-settings";
import * as repositoryResolution from "../../src/repos/resolve";
import { cleanD1Tables } from "./cleanup";
import { seedImageRowForScope } from "./image-build-helpers";
import { serviceRequestHeaders, type ServiceRequestInit } from "./helpers";
import {
  assignCustomRole,
  expectStatus,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const BASE = "https://test.local";
const MEMBER = "22222222222222222222222222222222";
const MANAGER_PERMISSIONS: PermissionId[] = [
  "environments.read",
  "environments.manage",
  "environments.use",
  "environments.secrets.manage",
  "environments.settings.manage",
  "environments.images.manage",
  "integrations.read",
  "image_builds.read",
];
const WEB: EnvironmentRepositoryInsert = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 1,
  base_branch: "main",
};
const API = { ...WEB, position: 1, repo_name: "api", repo_id: 2 };
const CREATE_BODY = {
  name: "Created",
  repositories: [{ repoOwner: WEB.repo_owner, repoName: WEB.repo_name }],
};
const store = new EnvironmentStore(env.DB);
const memberships = new TeamMembershipStore(env.DB);

function request(path: string, method = "GET", body?: object, init: ServiceRequestInit = {}) {
  return ownershipRequest(path, {
    method,
    ...init,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function removePermission(permission: PermissionId) {
  return env.DB.prepare("DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?")
    .bind(`role_custom_${MEMBER}`, permission)
    .run();
}
function memberRequest(path: string, method = "GET", body?: object) {
  return request(path, method, body, { as: { userId: MEMBER, role: "member" } });
}
async function team(slug: string, installation = true) {
  const id = await seedTeam(`team_${slug}`);
  if (installation) await seedGrant(id, "installation");
  return id;
}
function environment(
  ownerTeamId: string | null,
  name = "Seeded",
  repositories = [WEB],
  prebuildEnabled = false
) {
  return seedEnvironment(`env_${crypto.randomUUID()}`, ownerTeamId, repositories, {
    name,
    prebuild_enabled: prebuildEnabled ? 1 : 0,
  });
}

describe("environment team ownership", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`);
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: MEMBER, role: "member" },
    });
    await assignCustomRole(MEMBER, MANAGER_PERMISSIONS);
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repositories) =>
        repositories.map((repo) => ({
          ...repo,
          repoId: repo.repoName === "web" ? 1 : 2,
          baseBranch: repo.baseBranch ?? "main",
        }))
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, null])("enforces workspace CRUD/team settings (%s)", async (teamId) => {
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id = ? AND permission_id != 'environments.manage'"
    )
      .bind(`role_custom_${MEMBER}`)
      .run();
    const capabilities = { canRead: false, canManage: true, canUse: false };
    const response = await memberRequest("/environments", "POST", { ...CREATE_BODY, teamId });
    expect(response.status).toBe(201);
    const { environment: created } = await response.json<{ environment: Environment }>();
    expect(created).toMatchObject({ ownerTeamId: null, capabilities });
    const path = `/environments/${created.id}`;
    const read = await memberRequest(path);
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ reason_code: "missing_permission" });
    const updated = await memberRequest(path, "PUT", { description: "Managed" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      environment: { description: "Managed", capabilities },
    });
    expect((await store.getById(created.id))?.description).toBe("Managed");
    await expectStatus(memberRequest(path, "DELETE"), 200);
    expect(await store.getById(created.id)).toBeNull();
    await new TeamSettingsStore(env.DB).set({ requireTeamOnCreate: true });
    vi.mocked(repositoryResolution.resolveSessionRepositories).mockClear();
    const denied = await memberRequest("/environments", "POST", { ...CREATE_BODY, teamId });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "team_required" });
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
  });

  it("requires lead authority to create a team environment even with the manage grant", async () => {
    const id = await team("creation");
    const body = { ...CREATE_BODY, teamId: id };
    expect((await memberRequest("/environments", "POST", body)).status).toBe(403);
    await memberships.add(id, MEMBER);
    const denied = await memberRequest("/environments", "POST", body);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "not_owner_or_lead" });
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
    await memberships.setRole(id, MEMBER, "lead");
    const created = await memberRequest("/environments", "POST", body);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      environment: {
        ownerTeamId: id,
        capabilities: { canRead: true, canManage: true, canUse: true },
      },
    });
  });

  it("rejects missing/archived create teams before repository resolution", async () => {
    expect(
      (await request("/environments", "POST", { ...CREATE_BODY, teamId: "team_missing" })).status
    ).toBe(404);
    const id = await team("archived");
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(id).run();
    const response = await request("/environments", "POST", { ...CREATE_BODY, teamId: id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason_code: "team_archived" });
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
  });

  it("scopes case-insensitive create/rename conflicts to the owner and permits self-renames", async () => {
    const first = await team("first");
    const second = await team("second");
    await environment(null, "Taken");
    await environment(first, "Taken");
    const body = { ...CREATE_BODY, name: "taken", teamId: second };
    const response = await request("/environments", "POST", body);
    expect(response.status).toBe(201);
    const { environment: created } = await response.json<{ environment: Environment }>();
    expect((await request("/environments", "POST", { ...body, name: "TAKEN" })).status).toBe(409);
    const rename = await environment(second, "Before");
    expect((await request(`/environments/${rename}`, "PUT", { name: "Taken" })).status).toBe(409);
    await expectStatus(request(`/environments/${created.id}`, "PUT", { name: "TAKEN" }), 200);
    expect((await request(`/environments/${rename}`, "PUT", { name: "Other" })).status).toBe(200);
  });

  it("filters lists by viewer and exact scope with visible totals/capabilities", async () => {
    const visible = await team("visible");
    const hidden = await team("hidden");
    await memberships.add(visible, MEMBER);
    const workspaceId = await environment(null, "Workspace");
    const visibleId = await environment(visible, "Visible");
    await environment(hidden, "Hidden");
    const list = await (
      await memberRequest("/environments")
    ).json<{ environments: Environment[]; total: number }>();
    expect(list.total).toBe(2);
    expect(list.environments.map((row) => row.id).sort()).toEqual([workspaceId, visibleId].sort());
    for (const row of list.environments) {
      expect(row.capabilities).toEqual({
        canRead: true,
        canManage: row.ownerTeamId === null,
        canUse: true,
      });
    }
    for (const [teamId, ids] of [
      [visible, [visibleId]],
      [hidden, []],
      ["null", [workspaceId]],
    ] as const) {
      const page = await (
        await memberRequest(`/environments?teamId=${teamId}`)
      ).json<{ environments: Environment[]; total: number }>();
      expect(page.total).toBe(ids.length);
      expect(page.environments.map((row) => row.id)).toEqual(ids);
    }
    await expectStatus(memberRequest(`/environments?teamId=${visible}&teamId=${hidden}`), 400);
  });

  it("conceals outsider CRUD and denies member management without mutating the row", async () => {
    const teamId = await team("item-access");
    const id = await environment(teamId);
    const original = await store.getById(id);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await memberRequest(
        `/environments/${id}`,
        method,
        method === "PUT" ? {} : undefined
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Environment not found" });
    }
    await memberships.add(teamId, MEMBER);
    expect(await (await memberRequest(`/environments/${id}`)).json()).toMatchObject({
      environment: {
        capabilities: { canRead: true, canManage: false, canUse: true },
      },
    });
    const denied = await memberRequest(`/environments/${id}`, "PUT", {
      description: "Must not save",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "not_owner_or_lead" });
    expect(await store.getById(id)).toEqual(original);
    expect(repositoryResolution.resolveSessionRepositories).not.toHaveBeenCalled();
  });

  it("validates all resolved/final grants on create and scalar edits but permits repair", async () => {
    const teamId = await team("revoked", false);
    await seedGrant(teamId, WEB);
    const create = await request("/environments", "POST", {
      ...CREATE_BODY,
      teamId,
      repositories: [WEB, API].map((repo) => ({
        repoOwner: repo.repo_owner,
        repoName: repo.repo_name,
      })),
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/group/api",
    });
    expect((await store.list()).total).toBe(0);
    const id = await environment(teamId, "Revoked", [WEB, API]);
    const denied = await request(`/environments/${id}`, "PUT", { description: "Must not save" });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/group/api",
    });
    expect((await store.getById(id))?.description).toBeNull();
    const repaired = await request(`/environments/${id}`, "PUT", {
      repositories: CREATE_BODY.repositories,
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({
      environment: { capabilities: { canManage: true }, repositories: [{ repoId: 1 }] },
    });
    const repositories = await store.getRepositoriesForEnvironment(id);
    expect(repositories.map((repo) => repo.repo_id)).toEqual([1]);
  });

  it("requires numeric repository IDs despite matching names and repairs to resolved identity", async () => {
    const teamId = await team("numeric", false);
    await seedGrant(teamId, { ...WEB, repo_owner: "ACME/GROUP", repo_name: "WEB" });
    const id = await environment(teamId);
    for (const repoId of [null, 99]) {
      await store.replaceRepositories(id, [{ ...WEB, repo_id: repoId }]);
      const denied = await request(`/environments/${id}`, "PUT", { description: "Denied" });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        code: "target_team_missing_grant",
        repository: "acme/group/web",
      });
      expect((await store.getById(id))?.description).toBeNull();
    }
    const updated = await request(`/environments/${id}`, "PUT", {
      repositories: CREATE_BODY.repositories,
      description: "Canonical",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      environment: { description: "Canonical", repositories: [{ repoId: 1 }] },
    });
    await store.replaceRepositories(id, [{ ...WEB, repo_id: null }]);
    await seedGrant(teamId, "installation");
    await expectStatus(request(`/environments/${id}`, "PUT", { description: "Granted" }), 200);
    expect((await store.getRepositoriesForEnvironment(id))[0].repo_id).toBeNull();
  });

  it("conceals environment adjunct routes and keeps their extra permission requirements", async () => {
    const teamId = await team("adjunct");
    const id = await environment(teamId);
    const secretsPath = `/environments/${id}/secrets`;
    const settingsPath = `/integration-settings/sandbox/environments/${id}`;
    const secrets = { secrets: { TOKEN: "value" } };
    const settings = { settings: { terminalEnabled: true } };
    const paths = [
      ["GET", secretsPath, undefined],
      ["PUT", secretsPath, secrets],
      ["DELETE", `/environments/${id}/secrets/TOKEN`, undefined],
      [
        "POST",
        `/environments/${id}/secrets/import`,
        { repoOwner: WEB.repo_owner, repoName: WEB.repo_name },
      ],
      ["GET", settingsPath, undefined],
      ["PUT", settingsPath, settings],
      ["DELETE", settingsPath, undefined],
      ["POST", `/image-builds/trigger/environment/${id}`, undefined],
    ] as const;
    for (const [method, path, body] of paths) {
      expect((await memberRequest(path, method, body)).status, `${method} ${path}`).toBe(404);
    }
    await memberships.add(teamId, MEMBER, "lead");
    await removePermission("environments.read");
    await expectStatus(memberRequest(secretsPath), 403);
    await expectStatus(memberRequest(secretsPath, "PUT", secrets), 200);
    await expectStatus(memberRequest(settingsPath, "PUT", settings), 200);
    await removePermission("environments.secrets.manage");
    await expectStatus(memberRequest(secretsPath, "PUT", secrets), 403);
  });

  it("filters image status/enabled feeds and conceals unauthorized explicit scopes", async () => {
    const visible = await team("images-visible");
    await memberships.add(visible, MEMBER);
    const visibleId = await environment(visible, "Visible images", [WEB], true);
    const hiddenId = await environment(await team("images-hidden"), "Hidden images", [WEB], true);
    for (const id of [visibleId, hiddenId]) {
      await seedImageRowForScope(
        { kind: "environment", id },
        { id: `image_${id}`, status: "ready" }
      );
    }
    const status = await memberRequest("/image-builds/status");
    const enabled = await memberRequest("/image-builds/enabled");
    expect(await status.json()).toMatchObject({ images: [{ scopeId: visibleId }] });
    expect(await enabled.json()).toMatchObject({ units: [{ scopeId: visibleId }] });
    const explicit = (id: string) => `/image-builds/status?scope_kind=environment&scope_id=${id}`;
    expect((await memberRequest(explicit(hiddenId))).status).toBe(404);
    expect((await memberRequest(explicit(visibleId))).status).toBe(200);
    await removePermission("environments.read");
    expect(await (await memberRequest("/image-builds/status")).json()).toEqual({ images: [] });
    expect(await (await memberRequest("/image-builds/enabled")).json()).toMatchObject({
      units: [],
    });
    const forbidden = await memberRequest(explicit(visibleId));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ reason_code: "missing_permission" });
    expect((await memberRequest(explicit(hiddenId))).status).toBe(404);
  });

  it("preserves distinct actorless list/item ceilings and service capabilities", async () => {
    const id = await environment(await team("bot-read"));
    const capabilities = { canRead: true, canManage: false, canUse: true };
    for (const service of ["slack-bot", "linear-bot"] as const) {
      const list = await request("/environments", "GET", undefined, { service });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ environments: [{ id, capabilities }], total: 1 });
      await expectStatus(request(`/environments/${id}`, "GET", undefined, { service }), 403);
    }
    await expectStatus(request("/environments", "GET", undefined, { service: "github-bot" }), 403);
    const response = await request(`/environments/${id}`, "GET", undefined, {
      service: "github-bot",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ environment: { id, capabilities } });
  });
});
