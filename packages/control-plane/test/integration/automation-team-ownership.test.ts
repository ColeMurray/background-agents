import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { TeamSettingsStore } from "../../src/db/team-settings";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

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

function request(
  path: string,
  userId = EXECUTOR,
  method = "GET",
  body?: unknown
): Promise<Response> {
  return serviceFetch(`https://cp.test${path}`, {
    as: { userId, role: userId === ADMIN ? "administrator" : "member" },
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function team(id: string, members: Array<[string, "member" | "lead"]>): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
  )
    .bind(id, id, id)
    .run();
  for (const [userId, role] of members) {
    await env.DB.prepare(
      "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, ?, 1)"
    )
      .bind(id, userId, role)
      .run();
  }
}

function automation(id: string, ownerTeamId: string | null, createdAt = 1): AutomationRow {
  return {
    id,
    owner_team_id: ownerTeamId,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: EXECUTOR,
    user_id: EXECUTOR,
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
  };
}

async function environment(id: string, ownerTeamId: string | null, repoId?: number) {
  await new EnvironmentStore(env.DB).create(
    {
      id,
      name: id,
      owner_team_id: ownerTeamId,
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    },
    repoId === undefined
      ? []
      : [{ position: 0, repo_owner: "acme", repo_name: id, repo_id: repoId, base_branch: "main" }]
  );
}

async function grant(teamId: string, repoId: number, repoOwner: string, repoName: string) {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
     (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, 'repository', ?, ?, ?, 1)`
  )
    .bind(`${teamId}-${repoId}`, teamId, repoId, repoOwner, repoName)
    .run();
}

async function customRole(userId: string, permissions: readonly PermissionId[]): Promise<void> {
  const roleId = "role_automation_custom";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
       VALUES (?, NULL, 'Automation Custom', 'automation custom', NULL, 0)`
    ).bind(roleId),
    ...permissions.map((permission) =>
      env.DB.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)").bind(
        roleId,
        permission
      )
    ),
    env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
      roleId,
      userId
    ),
  ]);
}

describe("automation team ownership", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, MEMBER, ADMIN]) {
      expect((await request("/me/authorization", userId)).status).toBe(200);
    }
    await team(TEAM_A, [
      [EXECUTOR, "member"],
      [LEAD, "lead"],
      [MEMBER, "member"],
    ]);
    await team(TEAM_B, [[EXECUTOR, "member"]]);
  });
  afterEach(cleanD1Tables);

  it("defaults creation to workspace and returns request-specific capabilities", async () => {
    const response = await request("/automations", EXECUTOR, "POST", createBody);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      automation: {
        ownerTeamId: null,
        userId: EXECUTOR,
        capabilities: { canRead: true, canManage: true, canTrigger: true },
      },
    });
  });

  it.each([null, TEAM_A])(
    "returns executor capabilities for owner team %s",
    async (ownerTeamId) => {
      await new AutomationStore(env.DB).create(automation("executor-capabilities", ownerTeamId));
      const response = await request("/automations/executor-capabilities", EXECUTOR);
      expect(response.status).toBe(200);
      const result = await response.json<{ automation: { capabilities: unknown } }>();
      expect(result.automation.capabilities).toEqual({
        canRead: true,
        canManage: true,
        canTrigger: true,
      });
      const listed = await request("/automations", EXECUTOR);
      const page = await listed.json<{
        automations: Array<{ id: string; capabilities: unknown }>;
      }>();
      expect(page.automations).toHaveLength(1);
      expect(page.automations[0]?.id).toBe("executor-capabilities");
      expect(page.automations[0]?.capabilities).toEqual({
        canRead: true,
        canManage: true,
        canTrigger: true,
      });
    }
  );

  it.each([undefined, null])("requires an explicit team when configured (%s)", async (teamId) => {
    await new TeamSettingsStore(env.DB).set({ requireTeamOnCreate: true });
    const response = await request("/automations", EXECUTOR, "POST", { ...createBody, teamId });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "team_required" });
  });

  it("creates in a team only when its canonical executor is a member", async () => {
    const created = await request("/automations", EXECUTOR, "POST", {
      ...createBody,
      teamId: TEAM_A,
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      automation: { ownerTeamId: TEAM_A, userId: EXECUTOR },
    });
    const denied = await request("/automations", ADMIN, "POST", { ...createBody, teamId: TEAM_A });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ reason_code: "not_member" });
  });

  it("rejects archived team creation with the archived reason code", async () => {
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = ?").bind(TEAM_A).run();
    const response = await request("/automations", EXECUTOR, "POST", {
      ...createBody,
      teamId: TEAM_A,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason_code: "team_archived" });
  });

  it("filters visibility before pagination and supports an exact team filter", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("hidden-newest", TEAM_B, 4));
    await store.create(automation("visible-team", TEAM_A, 3));
    await store.create(automation("visible-workspace", null, 2));
    const first = await request("/automations?limit=1", MEMBER);
    const page = await first.json<{
      automations: Array<{ id: string; ownerTeamId: string | null; capabilities: unknown }>;
      nextCursor: string;
      hasMore: boolean;
    }>();
    expect(page).toMatchObject({
      automations: [
        { id: "visible-team", ownerTeamId: TEAM_A, capabilities: { canManage: false } },
      ],
      hasMore: true,
    });
    const second = await request(
      `/automations?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      MEMBER
    );
    await expect(second.json()).resolves.toMatchObject({
      automations: [{ id: "visible-workspace" }],
      hasMore: false,
      nextCursor: null,
    });
    const filtered = await request(`/automations?teamId=${TEAM_A}`, MEMBER);
    await expect(filtered.json()).resolves.toMatchObject({
      automations: [{ id: "visible-team" }],
      hasMore: false,
    });
    const hidden = await request(`/automations?teamId=${TEAM_B}`, MEMBER);
    await expect(hidden.json()).resolves.toMatchObject({ automations: [] });
    const workspace = await request("/automations?teamId=null", MEMBER);
    await expect(workspace.json()).resolves.toMatchObject({
      automations: [{ id: "visible-workspace" }],
      hasMore: false,
    });
    const admin = await request("/automations", ADMIN);
    const adminPage = await admin.json<{ automations: Array<{ id: string }> }>();
    expect(adminPage.automations.map((row) => row.id)).toEqual([
      "hidden-newest",
      "visible-team",
      "visible-workspace",
    ]);
  });

  it.each(
    invisibleRoutes.flatMap((route) => ["member", "custom-any"].map((role) => ({ ...route, role })))
  )(
    "returns the missing-resource 404 for $role outsiders on $method /automations/:id$suffix",
    async ({ method, suffix, body, role }) => {
      const store = new AutomationStore(env.DB);
      await store.create(automation("hidden-resource", TEAM_B));
      if (role === "custom-any") {
        await customRole(MEMBER, [
          "automations.read",
          "automations.manage.any",
          "automations.trigger.any",
        ]);
      }
      const hiddenPath = `/automations/hidden-resource${suffix}`;
      const missingPath = `/automations/missing-resource${suffix}`;
      const hidden = await request(hiddenPath, MEMBER, method, body);
      const missing = await request(missingPath, MEMBER, method, body);
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      const missingBody = await missing.json();
      expect(missingBody).toEqual({ error: "Automation not found" });
      await expect(hidden.json()).resolves.toEqual(missingBody);
      expect(await store.getById("hidden-resource")).toMatchObject({
        name: "hidden-resource",
        user_id: EXECUTOR,
        owner_team_id: TEAM_B,
        enabled: 1,
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

  it.each([
    ["own", EXECUTOR, 200],
    ["own", MEMBER, 403],
    ["own", LEAD, 200],
    ["any", EXECUTOR, 200],
    ["any", MEMBER, 200],
    ["any", LEAD, 200],
  ] as const)("preserves manage.%s without read for %s", async (scope, userId, status) => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("no-read-management", TEAM_A));
    await customRole(userId, [`automations.manage.${scope}`]);
    const read = await request("/automations/no-read-management", userId);
    expect(read.status).toBe(403);
    await expect(read.json()).resolves.toMatchObject({ reason_code: "missing_permission" });
    const update = await request("/automations/no-read-management", userId, "PUT", {
      name: "Managed without read",
    });
    expect(update.status).toBe(status);
    if (status === 200) {
      await expect(update.json()).resolves.toMatchObject({
        automation: {
          name: "Managed without read",
          capabilities: { canRead: false, canManage: true },
        },
      });
    } else {
      await expect(update.json()).resolves.toMatchObject({ reason_code: "not_owner_or_lead" });
      expect((await store.getById("no-read-management"))?.name).toBe("no-read-management");
    }
  });

  it("lets a team lead manage another executor's automation", async () => {
    await new AutomationStore(env.DB).create(automation("lead-managed", TEAM_A));
    const response = await request("/automations/lead-managed", LEAD, "PUT", {
      name: "Managed by lead",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      automation: { capabilities: { canManage: true, canTrigger: true } },
    });
  });

  it("does not let an ordinary executor change the executor", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("executor-change", TEAM_A));
    const response = await request("/automations/executor-change", EXECUTOR, "PATCH", {
      userId: MEMBER,
    });
    expect(response.status).toBe(403);
    expect((await store.getById("executor-change"))?.user_id).toBe(EXECUTOR);
  });

  it("changes executor as a lead and writes the domain audit with the mutation", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("executor-change", TEAM_A));
    const response = await request("/automations/executor-change", LEAD, "PATCH", {
      userId: MEMBER,
    });
    expect(response.status).toBe(200);
    expect((await store.getById("executor-change"))?.user_id).toBe(MEMBER);
    const audit = await env.DB.prepare(
      "SELECT resource_type, resource_id, team_id, target_user_id_snapshot, metadata_json FROM authorization_audit_events WHERE action = 'automation.executor_changed' AND operation_result = 'applied'"
    ).first();
    expect(audit).toMatchObject({
      resource_type: "automation",
      resource_id: "executor-change",
      team_id: TEAM_A,
      target_user_id_snapshot: MEMBER,
    });
    expect(JSON.parse(String(audit?.metadata_json))).toMatchObject({
      before: { userId: EXECUTOR },
      after: { userId: MEMBER },
    });
    const repeated = await request("/automations/executor-change", LEAD, "PATCH", {
      userId: MEMBER,
    });
    expect(repeated.status).toBe(200);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("rolls back an executor mutation when its batched audit fails", async () => {
    const store = new AutomationStore(env.DB);
    const row = automation("executor-change", TEAM_A);
    await store.create(row);
    await expect(
      sqlDatabase(env.DB).batch([
        store.bindExecutorChange(row, MEMBER),
        env.DB.prepare("INSERT INTO authorization_audit_events (id) VALUES ('invalid-audit')"),
      ])
    ).rejects.toThrow();
    expect((await store.getById(row.id))?.user_id).toBe(EXECUTOR);
  });

  it("allows administrator reassignment of a workspace automation", async () => {
    await new AutomationStore(env.DB).create(automation("workspace-executor", null));
    const response = await request("/automations/workspace-executor", ADMIN, "PATCH", {
      userId: MEMBER,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      automation: { ownerTeamId: null, userId: MEMBER },
    });
  });

  it.each(["missing", "suspended", "unassigned", "non-member"])(
    "rejects an invalid canonical executor (%s)",
    async (kind) => {
      const store = new AutomationStore(env.DB);
      await store.create(automation("executor-change", TEAM_A));
      if (kind === "suspended")
        await env.DB.prepare("UPDATE users SET suspended_at = 2 WHERE id = ?").bind(MEMBER).run();
      if (kind === "unassigned")
        await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
          .bind(MEMBER)
          .run();
      const userId =
        kind === "missing"
          ? "ffffffffffffffffffffffffffffffff"
          : kind === "non-member"
            ? ADMIN
            : MEMBER;
      const response = await request("/automations/executor-change", LEAD, "PATCH", { userId });
      expect(response.status).toBe(kind === "missing" ? 404 : kind === "non-member" ? 403 : 409);
      expect((await store.getById("executor-change"))?.user_id).toBe(EXECUTOR);
    }
  );

  it("rejects provider identities as executor IDs", async () => {
    await new AutomationStore(env.DB).create(automation("executor-change", TEAM_A));
    const response = await request("/automations/executor-change", LEAD, "PATCH", {
      userId: "github:583231",
    });
    expect(response.status).toBe(400);
  });

  it.each([null, 71, 72])(
    "requires numeric repository identity on target updates (repoId %s)",
    async (repoId) => {
      const store = new AutomationStore(env.DB);
      await store.create(automation("grant-update", TEAM_A));
      await store.replaceRepositories("grant-update", [
        { repo_owner: "group/subgroup", repo_name: "api", repo_id: repoId, base_branch: "main" },
      ]);
      const denied = await request("/automations/grant-update", EXECUTOR, "PUT", {
        environmentIds: [],
      });
      expect(denied.status).toBe(409);
      await grant(TEAM_A, 71, "group/subgroup", "api");
      const response = await request("/automations/grant-update", EXECUTOR, "PUT", {
        environmentIds: [],
      });
      expect(response.status).toBe(repoId === 71 ? 200 : 409);
      expect((await store.getById("grant-update"))?.owner_team_id).toBe(TEAM_A);
      if (repoId !== 71) {
        await expect(response.json()).resolves.toMatchObject({ code: "target_team_missing_grant" });
      }
    }
  );

  it("revalidates unchanged environment grants and scope without requiring viewer use permission", async () => {
    const store = new AutomationStore(env.DB);
    await environment("env_unchanged", TEAM_A, 91);
    await store.create(automation("repository-edit", TEAM_A));
    await sqlDatabase(env.DB).batch(
      store.bindEnvironmentInserts("repository-edit", ["env_unchanged"], 1)
    );
    await customRole(LEAD, ["automations.manage.own", "automations.read"]);

    const missingGrant = await request("/automations/repository-edit", LEAD, "PUT", {
      repositories: [],
    });
    expect(missingGrant.status).toBe(409);
    await expect(missingGrant.json()).resolves.toMatchObject({
      reason_code: "target_team_missing_grant",
    });

    await grant(TEAM_A, 91, "acme", "env_unchanged");
    const updated = await request("/automations/repository-edit", LEAD, "PUT", {
      repositories: [],
    });
    expect(updated.status).toBe(200);
    expect(
      (await store.getEnvironmentsForAutomation("repository-edit")).map((row) => row.environment_id)
    ).toEqual(["env_unchanged"]);

    const replacement = await request("/automations/repository-edit", LEAD, "PUT", {
      environmentIds: ["env_unchanged"],
    });
    expect(replacement.status).toBe(403);
    await expect(replacement.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "environments.use",
    });

    await env.DB.prepare("UPDATE environments SET owner_team_id = ? WHERE id = ?")
      .bind(TEAM_B, "env_unchanged")
      .run();
    const mismatch = await request("/automations/repository-edit", LEAD, "PUT", {
      repositories: [],
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      reason_code: "environment_team_mismatch",
    });
  });

  it("allows a null repository ID on target updates with an installation grant", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(automation("grant-update", TEAM_A));
    await store.replaceRepositories("grant-update", [
      { repo_owner: "group/subgroup", repo_name: "api", repo_id: null, base_branch: "main" },
    ]);
    await env.DB.prepare(
      `INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at)
       VALUES ('automation-installation-grant', ?, 'installation', 1)`
    )
      .bind(TEAM_A)
      .run();
    const response = await request("/automations/grant-update", EXECUTOR, "PUT", {
      environmentIds: [],
    });
    expect(response.status).toBe(200);
    expect((await store.getById("grant-update"))?.owner_team_id).toBe(TEAM_A);
  });

  it.each([null, TEAM_B])(
    "refuses selecting an environment outside the automation team (%s)",
    async (ownerTeamId) => {
      await environment("env_cross", ownerTeamId);
      const response = await request("/automations", EXECUTOR, "POST", {
        ...createBody,
        teamId: TEAM_A,
        environmentIds: ["env_cross"],
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        reason_code: "environment_team_mismatch",
      });
    }
  );

  it("refuses selecting a team environment in a workspace automation", async () => {
    await environment("env_team", TEAM_A);
    const response = await request("/automations", EXECUTOR, "POST", {
      ...createBody,
      environmentIds: ["env_team"],
    });
    expect(response.status).toBe(409);
    await new AutomationStore(env.DB).create(automation("workspace-targets", null));
    const update = await request("/automations/workspace-targets", EXECUTOR, "PUT", {
      environmentIds: ["env_team"],
    });
    expect(update.status).toBe(409);
  });

  it("checks grants for every selected environment repository on create and update", async () => {
    await environment("env_one", TEAM_A, 11);
    await environment("env_two", TEAM_A, 22);
    await grant(TEAM_A, 11, "acme", "env_one");
    const body = { ...createBody, teamId: TEAM_A, environmentIds: ["env_one", "env_two"] };
    const denied = await request("/automations", EXECUTOR, "POST", body);
    expect(denied.status).toBe(409);
    await new AutomationStore(env.DB).create(automation("targets-update", TEAM_A));
    const update = await request("/automations/targets-update", EXECUTOR, "PUT", {
      environmentIds: body.environmentIds,
    });
    expect(update.status).toBe(409);
    await grant(TEAM_A, 22, "acme", "env_two");
    expect((await request("/automations", EXECUTOR, "POST", body)).status).toBe(201);
  });

  it("repairs a legacy canonical executor before admitting a team lead", async () => {
    const store = new AutomationStore(env.DB);
    await store.create({ ...automation("legacy-team", TEAM_A), user_id: null });
    const response = await request("/automations/legacy-team", LEAD);
    expect(response.status).toBe(200);
    expect((await store.getById("legacy-team"))?.user_id).toBe(EXECUTOR);
  });

  it("preserves actorless service credential ceilings on ID reads and mutations", async () => {
    await new AutomationStore(env.DB).create(automation("service-read", TEAM_A));
    const read = await serviceFetch("https://cp.test/automations/service-read", {
      service: "slack-bot",
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      automation: {
        ownerTeamId: TEAM_A,
        capabilities: { canRead: true, canManage: false, canTrigger: false },
      },
    });
    for (const service of ["github-bot", "linear-bot"] as const) {
      expect(
        (await serviceFetch("https://cp.test/automations/service-read", { service })).status
      ).toBe(403);
    }
    const mutate = await serviceFetch("https://cp.test/automations/service-read", {
      service: "slack-bot",
      method: "PATCH",
      body: JSON.stringify({ userId: MEMBER }),
    });
    expect(mutate.status).toBe(403);
  });
});
