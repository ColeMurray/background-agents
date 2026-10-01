import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "../../src/db/automation-store";
import { TeamSettingsStore } from "../../src/db/team-settings";
import * as routeShared from "../../src/routes/shared";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";
import {
  assignCustomRole,
  expectStatus,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const MEMBER = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const TEAM_A = "team_automation_a";
const TEAM_B = "team_automation_b";
const createBody = {
  name: "Team automation",
  instructions: "Run tests",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
};
const invisibleRoutes: Array<{ method: string; suffix: string; body?: unknown }> = [
  { method: "GET", suffix: "" },
  { method: "GET", suffix: "/invocations" },
  { method: "GET", suffix: "/runs/missing" },
  { method: "PUT", suffix: "", body: { name: "Must remain hidden" } },
  { method: "DELETE", suffix: "" },
  { method: "POST", suffix: "/pause" },
  { method: "POST", suffix: "/resume" },
  { method: "POST", suffix: "/trigger" },
  { method: "POST", suffix: "/regenerate-key" },
  { method: "PATCH", suffix: "", body: { userId: MEMBER } },
];

function request(path: string, userId = EXECUTOR, method = "GET", body?: unknown) {
  return ownershipRequest(path, {
    as: { userId, role: userId === ADMIN ? "administrator" : "member" },
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function automation(id: string, ownerTeamId: string | null, createdAt = 1) {
  await env.DB.prepare(
    `INSERT INTO automations
     (id, name, instructions, model, schedule_cron, created_by, user_id, owner_team_id, created_at, updated_at)
     VALUES (?, ?, 'Run tests', 'anthropic/claude-sonnet-4-6', '0 9 * * *', ?, ?, ?, ?, ?)`
  )
    .bind(id, id, EXECUTOR, EXECUTOR, ownerTeamId, createdAt, createdAt)
    .run();
}

const store = new AutomationStore(env.DB);
const repository = (id: number | null, name = "api") => ({
  position: 0,
  repo_owner: "group/subgroup",
  repo_name: name,
  repo_id: id,
  base_branch: "main",
});

describe("automation team ownership", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, MEMBER, ADMIN]) {
      expect((await request("/me/authorization", userId)).status).toBe(200);
    }
    await seedTeam(TEAM_A, [
      [EXECUTOR, "member"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    await seedTeam(TEAM_B, [[EXECUTOR, "member"]]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it.each([undefined, null])("enforces workspace/team defaults (%s)", async (teamId) => {
    const created = await request("/automations", EXECUTOR, "POST", { ...createBody, teamId });
    expect(created.status).toBe(201);
    const { automation: row } = await created.json<{ automation: { id: string } }>();
    const fetched = await request(`/automations/${row.id}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      automation: {
        ownerTeamId: null,
        userId: EXECUTOR,
        capabilities: { canRead: true, canManage: true, canTrigger: true },
      },
    });
    await new TeamSettingsStore(env.DB).set({ requireTeamOnCreate: true });
    const response = await request("/automations", EXECUTOR, "POST", { ...createBody, teamId });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "team_required" });
  });

  it("creates only for a member executor in an active team", async () => {
    const created = await request("/automations", EXECUTOR, "POST", {
      ...createBody,
      teamId: TEAM_A,
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      automation: {
        ownerTeamId: TEAM_A,
        userId: EXECUTOR,
        capabilities: { canRead: true, canManage: true, canTrigger: true },
      },
    });
    const denied = await request("/automations", ADMIN, "POST", { ...createBody, teamId: TEAM_A });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ reason_code: "not_member" });
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM_A).run();
    const archived = await request("/automations", EXECUTOR, "POST", {
      ...createBody,
      teamId: TEAM_A,
    });
    expect(archived.status).toBe(409);
    await expect(archived.json()).resolves.toMatchObject({ reason_code: "team_archived" });
  });

  it("filters visibility before pagination and supports exact team/workspace filters", async () => {
    await automation("hidden-newest", TEAM_B, 4);
    await automation("visible-team", TEAM_A, 3);
    await automation("visible-workspace", null, 2);
    const page = await (
      await request("/automations?limit=1", MEMBER)
    ).json<{
      automations: unknown[];
      nextCursor: string;
      hasMore: boolean;
    }>();
    expect(page).toMatchObject({
      automations: [
        { id: "visible-team", ownerTeamId: TEAM_A, capabilities: { canManage: false } },
      ],
      hasMore: true,
    });
    const next = await request(
      `/automations?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      MEMBER
    );
    await expect(next.json()).resolves.toMatchObject({
      automations: [{ id: "visible-workspace" }],
      hasMore: false,
      nextCursor: null,
    });
    for (const [teamId, ids] of [
      [TEAM_A, ["visible-team"]],
      [TEAM_B, []],
      ["null", ["visible-workspace"]],
    ] as const) {
      const response = await request(`/automations?teamId=${teamId}`, MEMBER);
      const filtered = await response.json<{ automations: { id: string }[]; hasMore: boolean }>();
      expect(filtered.automations.map((row) => row.id)).toEqual(ids);
      expect(filtered.hasMore).toBe(false);
    }
    const admin = await (
      await request("/automations", ADMIN)
    ).json<{ automations: { id: string }[] }>();
    expect(admin.automations.map((row) => row.id)).toEqual([
      "hidden-newest",
      "visible-team",
      "visible-workspace",
    ]);
  });

  describe("custom-any outsiders", () => {
    beforeEach(async () => {
      await automation("hidden-resource", TEAM_B);
      await assignCustomRole(MEMBER, [
        "automations.read",
        "automations.manage.any",
        "automations.trigger.any",
      ]);
    });
    it.each(invisibleRoutes)(
      "conceals $method /automations/:id$suffix without handler effects",
      async ({ method, suffix, body }) => {
        const original = await store.getById("hidden-resource");
        const hiddenPath = `/automations/hidden-resource${suffix}`;
        const missingPath = `/automations/missing-resource${suffix}`;
        for (const path of [hiddenPath, missingPath]) {
          const response = await request(path, MEMBER, method, body);
          expect(response.status).toBe(404);
          await expect(response.json()).resolves.toEqual({ error: "Automation not found" });
        }
        expect(await store.getById("hidden-resource")).toEqual(original);
        expect(
          await env.DB.prepare("SELECT COUNT(*) AS count FROM automation_invocations").first()
        ).toEqual({ count: 0 });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
          count: 0,
        });
        const denied = await env.DB.prepare(
          `SELECT resource_id, team_id FROM authorization_audit_events
         WHERE action = 'authorization.request_denied' AND operation_result = 'denied'
           AND actor_user_id_snapshot = ? AND resource_id IN (?, ?)`
        )
          .bind(MEMBER, hiddenPath, missingPath)
          .all();
        expect(denied.results).toHaveLength(2);
        expect(denied.results).toEqual(
          expect.arrayContaining([
            { resource_id: hiddenPath, team_id: TEAM_B },
            { resource_id: missingPath, team_id: null },
          ])
        );
      }
    );
  });

  it("lets a lead manage another executor's automation without read permission", async () => {
    await automation("no-read-management", TEAM_A);
    await assignCustomRole(LEAD, ["automations.manage.own"]);
    const read = await request("/automations/no-read-management", LEAD);
    expect(read.status).toBe(403);
    await expect(read.json()).resolves.toMatchObject({ reason_code: "missing_permission" });
    const update = await request("/automations/no-read-management", LEAD, "PUT", {
      name: "Managed",
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      automation: {
        name: "Managed",
        capabilities: { canRead: false, canManage: true },
      },
    });
    expect((await store.getById("no-read-management"))?.name).toBe("Managed");
  });

  it("reserves executor changes for leads and audits only effective changes", async () => {
    await automation("executor-change", TEAM_A);
    const path = "/automations/executor-change";
    await expectStatus(request(path, EXECUTOR, "PATCH", { userId: MEMBER }), 403);
    expect((await store.getById("executor-change"))?.user_id).toBe(EXECUTOR);
    const changed = await request(path, LEAD, "PATCH", {
      userId: MEMBER,
    });
    expect(changed.status).toBe(200);
    expect((await store.getById("executor-change"))?.user_id).toBe(MEMBER);
    const audit = await env.DB.prepare(
      "SELECT resource_type, resource_id, team_id, actor_user_id_snapshot, target_user_id_snapshot, metadata_json FROM authorization_audit_events WHERE action = 'automation.executor_changed' AND operation_result = 'applied'"
    ).first();
    expect(audit).toMatchObject({
      resource_type: "automation",
      resource_id: "executor-change",
      team_id: TEAM_A,
      actor_user_id_snapshot: LEAD,
      target_user_id_snapshot: MEMBER,
    });
    expect(JSON.parse(String(audit?.metadata_json))).toMatchObject({
      before: { userId: EXECUTOR },
      after: { userId: MEMBER },
    });
    await expectStatus(request(path, LEAD, "PATCH", { userId: MEMBER }), 200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
      ).first()
    ).toEqual({ count: 1 });
  });

  it("rolls back an executor mutation when its batched audit fails", async () => {
    await automation("executor-change", TEAM_A);
    const row = (await store.getById("executor-change"))!;
    await expect(
      sqlDatabase(env.DB).batch([
        store.bindExecutorChange(row, MEMBER),
        env.DB.prepare("INSERT INTO authorization_audit_events (id) VALUES ('invalid-audit')"),
      ])
    ).rejects.toThrow();
    expect((await store.getById(row.id))?.user_id).toBe(EXECUTOR);
  });

  it("allows administrator reassignment of a workspace automation", async () => {
    await automation("workspace-executor", null);
    const response = await request("/automations/workspace-executor", ADMIN, "PATCH", {
      userId: MEMBER,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      automation: { ownerTeamId: null, userId: MEMBER },
    });
    expect((await store.getById("workspace-executor"))?.user_id).toBe(MEMBER);
  });

  it.each(["missing", "suspended", "unassigned", "non-member", "provider identity"])(
    "rejects an invalid executor (%s) without a mutation",
    async (kind) => {
      await automation("executor-change", TEAM_A);
      if (kind === "suspended")
        await env.DB.prepare("UPDATE users SET suspended_at = 2 WHERE id = ?").bind(MEMBER).run();
      if (kind === "unassigned")
        await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
          .bind(MEMBER)
          .run();
      const targets = {
        missing: ["f".repeat(32), 404],
        suspended: [MEMBER, 409],
        unassigned: [MEMBER, 409],
        "non-member": [ADMIN, 403],
        "provider identity": ["github:583231", 400],
      } as const;
      const [userId, status] = targets[kind as keyof typeof targets];
      expect(
        (await request("/automations/executor-change", LEAD, "PATCH", { userId })).status
      ).toBe(status);
      expect((await store.getById("executor-change"))?.user_id).toBe(EXECUTOR);
    }
  );

  it.each([null, 71, 72])("uses numeric grant identity on target updates (%s)", async (repoId) => {
    await automation("grant-update", TEAM_A);
    await store.replaceRepositories("grant-update", [repository(repoId)]);
    const body = { environmentIds: [] };
    await expectStatus(request("/automations/grant-update", EXECUTOR, "PUT", body), 409);
    await seedGrant(TEAM_A, repository(71));
    const response = await request("/automations/grant-update", EXECUTOR, "PUT", {
      environmentIds: [],
    });
    expect(response.status).toBe(repoId === 71 ? 200 : 409);
    if (repoId !== 71)
      await expect(response.json()).resolves.toMatchObject({ code: "target_team_missing_grant" });
    expect((await store.getById("grant-update"))?.owner_team_id).toBe(TEAM_A);
    await seedGrant(TEAM_A, "installation");
    await expectStatus(request("/automations/grant-update", EXECUTOR, "PUT", body), 200);
    expect((await store.getRepositoriesForAutomation("grant-update"))[0].repo_id).toBe(repoId);
  });

  it("revalidates unchanged environment grants without use permission, but requires use for replacement", async () => {
    await seedEnvironment("env_unchanged", TEAM_A, [repository(91)]);
    await automation("repository-edit", TEAM_A);
    await sqlDatabase(env.DB).batch(
      store.bindEnvironmentInserts("repository-edit", ["env_unchanged"], 1)
    );
    const original = await store.getEnvironmentsForAutomation("repository-edit");
    await assignCustomRole(LEAD, ["automations.manage.own", "repositories.use"]);
    const path = "/automations/repository-edit";
    const missingGrant = await request(path, LEAD, "PUT", {
      repositories: [],
    });
    expect(missingGrant.status).toBe(409);
    await expect(missingGrant.json()).resolves.toMatchObject({
      reason_code: "target_team_missing_grant",
    });
    await seedGrant(TEAM_A, repository(91));
    vi.spyOn(routeShared, "resolveRepoOrError").mockResolvedValue({
      repoId: 91,
      repoOwner: "group/subgroup",
      repoName: "api",
      defaultBranch: "main",
    });
    await expectStatus(
      request(path, LEAD, "PUT", {
        repositories: [{ repoOwner: "group/subgroup", repoName: "api" }],
      }),
      200
    );
    expect((await store.getRepositoriesForAutomation("repository-edit"))[0].repo_id).toBe(91);
    expect(await store.getEnvironmentsForAutomation("repository-edit")).toEqual(original);
    const replacement = await request(path, LEAD, "PUT", {
      environmentIds: ["env_unchanged"],
    });
    expect(replacement.status).toBe(403);
    await expect(replacement.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "environments.use",
    });
  });

  it("conceals unchanged non-member environments in stored order without replacing selections", async () => {
    const ids = ["env_hidden_z", "env_missing", "env_hidden_a"];
    await automation("unchanged-hidden", TEAM_A);
    await sqlDatabase(env.DB).batch(store.bindEnvironmentInserts("unchanged-hidden", ids, 1));
    await assignCustomRole(LEAD, ["automations.manage.own"]);
    for (const id of ["env_hidden_a", "env_hidden_z"]) await seedEnvironment(id, TEAM_B);
    const hidden = await request("/automations/unchanged-hidden", LEAD, "PUT", {
      repositories: [],
    });
    expect(hidden.status).toBe(400);
    expect(await hidden.text()).toBe(
      JSON.stringify({ error: `Environment not found: ${[...ids].sort().join(", ")}` })
    );
    expect(
      (await store.getEnvironmentsForAutomation("unchanged-hidden")).map(
        (row) => row.environment_id
      )
    ).toEqual([...ids].sort());
  });

  it.each(["POST", "PUT"])(
    "checks environment ownership through %s without changing selections",
    async (method) => {
      await automation("owner-check", TEAM_A);
      await seedEnvironment("env_other_team", TEAM_B);
      const original = await store.getById("owner-check");
      const path = method === "POST" ? "/automations" : "/automations/owner-check";
      const response = await request(path, EXECUTOR, method, {
        ...createBody,
        teamId: TEAM_A,
        environmentIds: ["env_other_team"],
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        reason_code: "environment_team_mismatch",
      });
      expect(await store.getById("owner-check")).toEqual(original);
      expect(await store.getEnvironmentsForAutomation("owner-check")).toEqual([]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM automations").first()).toEqual({
        count: 1,
      });
    }
  );

  it("selects environments with use but no read through create and update", async () => {
    await seedEnvironment("env_use_only", TEAM_A);
    await assignCustomRole(LEAD, [
      "automations.create",
      "automations.manage.own",
      "environments.use",
    ]);
    const created = await request("/automations", LEAD, "POST", {
      ...createBody,
      teamId: TEAM_A,
      environmentIds: ["env_use_only"],
    });
    expect(created.status).toBe(201);
    const { automation: selected } = await created.json<{ automation: { id: string } }>();
    await expectStatus(
      request(`/automations/${selected.id}`, LEAD, "PUT", { environmentIds: ["env_use_only"] }),
      200
    );
    expect(
      (await store.getEnvironmentsForAutomation(selected.id)).map((row) => row.environment_id)
    ).toEqual(["env_use_only"]);
  });

  it("checks grants for every selected environment repository on create and update", async () => {
    await seedEnvironment("env_one", TEAM_A, [repository(11, "one")]);
    await seedEnvironment("env_two", TEAM_A, [repository(22, "two")]);
    await seedGrant(TEAM_A, repository(11, "one"));
    const environmentIds = ["env_one", "env_two"];
    const body = { ...createBody, teamId: TEAM_A, environmentIds };
    expect((await request("/automations", EXECUTOR, "POST", body)).status).toBe(409);
    await automation("targets-update", TEAM_A);
    await expectStatus(
      request("/automations/targets-update", EXECUTOR, "PUT", { environmentIds }),
      409
    );
    expect(await store.getEnvironmentsForAutomation("targets-update")).toEqual([]);
    await seedGrant(TEAM_A, repository(22, "two"));
    expect((await request("/automations", EXECUTOR, "POST", body)).status).toBe(201);
  });

  it("preserves actorless service read capabilities and mutation ceilings", async () => {
    await automation("service-read", TEAM_A);
    const url = "https://cp.test/automations/service-read";
    const read = await serviceFetch(url, { service: "slack-bot" });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      automation: {
        ownerTeamId: TEAM_A,
        capabilities: { canRead: true, canManage: false, canTrigger: false },
      },
    });
    for (const service of ["github-bot", "linear-bot"] as const) {
      expect((await serviceFetch(url, { service })).status).toBe(403);
    }
    await expectStatus(
      serviceFetch(url, {
        service: "slack-bot",
        method: "PATCH",
        body: JSON.stringify({ userId: MEMBER }),
      }),
      403
    );
    expect((await store.getById("service-read"))?.user_id).toBe(EXECUTOR);
  });
});
