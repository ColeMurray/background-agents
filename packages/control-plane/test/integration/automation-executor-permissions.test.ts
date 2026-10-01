import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const CANDIDATE = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const TEAM = "team_executor_permissions";
const ENVIRONMENT = "env_executor_permissions";
const DIRECT_REPOSITORY = {
  repo_owner: "acme/group",
  repo_name: "direct",
  repo_id: 701,
  base_branch: "main",
};
const ENVIRONMENT_REPOSITORY = {
  ...DIRECT_REPOSITORY,
  position: 0,
  repo_name: "environment-member",
  repo_id: 702,
};
const LAUNCH_PERMISSIONS: PermissionId[] = [
  "sessions.create",
  "repositories.use",
  "environments.use",
];
const TARGETS = [
  { target: "repoless", permissions: ["sessions.create"] },
  { target: "direct", permissions: ["sessions.create", "repositories.use"] },
  { target: "environment", permissions: ["sessions.create", "environments.use"] },
  { target: "mixed", permissions: LAUNCH_PERMISSIONS },
] satisfies Array<{ target: string; permissions: PermissionId[] }>;

function patch(userId: string, callerId = LEAD): Promise<Response> {
  return serviceFetch("https://cp.test/automations/executor-permissions", {
    as: { userId: callerId, role: callerId === ADMIN ? "administrator" : "member" },
    method: "PATCH",
    body: JSON.stringify({ userId }),
  });
}

async function customRole(userId: string, permissions: readonly PermissionId[]): Promise<void> {
  const roleId = `role_executor_${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
       VALUES (?, NULL, ?, ?, NULL, 0)`
    ).bind(roleId, roleId, roleId),
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

async function saveAutomation(target: string, ownerTeamId: string | null = TEAM) {
  const repositories = target === "direct" || target === "mixed" ? [DIRECT_REPOSITORY] : [];
  const environmentIds = target === "environment" || target === "mixed" ? [ENVIRONMENT] : [];
  if (environmentIds.length > 0) {
    await new EnvironmentStore(env.DB).create(
      {
        id: ENVIRONMENT,
        owner_team_id: ownerTeamId,
        name: "Saved environment",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      },
      [ENVIRONMENT_REPOSITORY]
    );
  }
  const row: AutomationRow = {
    id: "executor-permissions",
    owner_team_id: ownerTeamId,
    name: "Saved executor permissions",
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
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
  };
  const store = new AutomationStore(env.DB);
  await store.create(row);
  if (repositories.length + environmentIds.length > 0) {
    await sqlDatabase(env.DB).batch([
      ...store.bindRepositoryInserts(row.id, repositories, 1),
      ...store.bindEnvironmentInserts(row.id, environmentIds, 1),
    ]);
  }
  if (ownerTeamId !== null) {
    for (const repository of [
      ...repositories,
      ...(environmentIds.length > 0 ? [ENVIRONMENT_REPOSITORY] : []),
    ]) {
      await env.DB.prepare(
        `INSERT INTO team_repository_grants
         (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
         VALUES (?, ?, 'repository', ?, ?, ?, 1)`
      )
        .bind(
          `grant-executor-${repository.repo_id}`,
          ownerTeamId,
          repository.repo_id,
          repository.repo_owner,
          repository.repo_name
        )
        .run();
    }
  }
  return row;
}

async function expectUnchanged(row: AutomationRow): Promise<void> {
  expect.soft(await new AutomationStore(env.DB).getById(row.id)).toEqual(row);
  const audit = await env.DB.prepare(
    "SELECT action FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
  ).all();
  expect.soft(audit.results).toEqual([]);
}

async function expectExecutionDenied(response: Response, row: AutomationRow): Promise<void> {
  expect.soft(response.status).toBe(403);
  expect.soft(await response.json()).toMatchObject({
    code: "automation_executor_unauthorized",
    reason_code: "execution_authorization_denied",
  });
  await expectUnchanged(row);
}

describe("automation executor launch permissions (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.batch([
      ...[EXECUTOR, LEAD, CANDIDATE, ADMIN].map((userId) =>
        env.DB.prepare(
          "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)"
        ).bind(userId, userId)
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
      ).bind(ADMIN),
      env.DB.prepare(
        "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
      ).bind(TEAM, TEAM, TEAM),
      ...[EXECUTOR, LEAD, CANDIDATE].map((userId) =>
        env.DB.prepare(
          "INSERT INTO team_memberships (team_id, user_id, role, created_at) VALUES (?, ?, ?, 1)"
        ).bind(TEAM, userId, userId === LEAD ? "lead" : "member")
      ),
    ]);
    await customRole(LEAD, ["automations.manage.own"]);
  });
  afterEach(cleanD1Tables);

  describe.each([
    { caller: "team lead with manage.own only", callerId: LEAD, ownerTeamId: TEAM },
    { caller: "workspace administrator", callerId: ADMIN, ownerTeamId: null },
  ])("$caller", ({ callerId, ownerTeamId }) => {
    it.each(
      TARGETS.flatMap(({ target, permissions }) =>
        permissions.map((missingPermission) => ({ target, missingPermission }))
      )
    )(
      "rejects a $target candidate missing $missingPermission before mutation or domain audit",
      async ({ target, missingPermission }) => {
        const row = await saveAutomation(target, ownerTeamId);
        await customRole(CANDIDATE, [
          ...LAUNCH_PERMISSIONS.filter((permission) => permission !== missingPermission),
          "automations.read",
          "automations.manage.any",
          "automations.trigger.any",
        ]);

        await expectExecutionDenied(await patch(CANDIDATE, callerId), row);
      }
    );

    it.each(TARGETS)(
      "accepts $target launch grants without candidate read, trigger, or manage permissions",
      async ({ target, permissions }) => {
        const row = await saveAutomation(target, ownerTeamId);
        await customRole(CANDIDATE, permissions);
        const store = new AutomationStore(env.DB);
        const repositories = await store.getRepositoriesForAutomation(row.id);
        const environments = await store.getEnvironmentsForAutomation(row.id);

        const response = await patch(CANDIDATE, callerId);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          automation: {
            id: row.id,
            ownerTeamId,
            userId: CANDIDATE,
            capabilities: { canManage: true, canRead: callerId === ADMIN },
          },
        });
        expect(await store.getById(row.id)).toEqual({
          ...row,
          user_id: CANDIDATE,
          updated_at: expect.any(Number),
        });
        expect(await store.getRepositoriesForAutomation(row.id)).toEqual(repositories);
        expect(await store.getEnvironmentsForAutomation(row.id)).toEqual(environments);
        const audit = await env.DB.prepare(
          `SELECT action, actor_user_id_snapshot, target_user_id_snapshot, resource_id,
             team_id, operation_result, metadata_json FROM authorization_audit_events
             WHERE action = 'automation.executor_changed'`
        ).all();
        expect(audit.results).toEqual([
          {
            action: "automation.executor_changed",
            actor_user_id_snapshot: callerId,
            target_user_id_snapshot: CANDIDATE,
            resource_id: row.id,
            team_id: ownerTeamId,
            operation_result: "applied",
            metadata_json: expect.any(String),
          },
        ]);
        expect(JSON.parse(String(audit.results[0]?.metadata_json))).toMatchObject({
          before: { userId: EXECUTOR },
          after: { userId: CANDIDATE },
        });

        const repeated = await patch(CANDIDATE, callerId);
        expect(repeated.status).toBe(200);
        const auditCount = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
        ).first<{ count: number }>();
        expect(auditCount?.count).toBe(1);
      }
    );

    it.each(TARGETS)(
      "rejects a same-ID $target executor after its required permissions are revoked",
      async ({ target }) => {
        const row = await saveAutomation(target, ownerTeamId);
        await customRole(EXECUTOR, []);

        await expectExecutionDenied(await patch(EXECUTOR, callerId), row);
      }
    );

    it.each(["workspace viewer", "permissionless custom role"])(
      "rejects an active candidate with a %s even for repoless execution",
      async (role) => {
        const row = await saveAutomation("repoless", ownerTeamId);
        if (role === "workspace viewer") {
          await env.DB.prepare(
            "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
          )
            .bind(CANDIDATE)
            .run();
        } else {
          await customRole(CANDIDATE, []);
        }

        await expectExecutionDenied(await patch(CANDIDATE, callerId), row);
      }
    );
  });

  it.each(["missing", "suspended", "unassigned"])(
    "preserves the %s canonical-user error ahead of execution or membership denial",
    async (state) => {
      const row = await saveAutomation("mixed");
      await customRole(CANDIDATE, []);
      await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
        .bind(TEAM, CANDIDATE)
        .run();
      if (state === "suspended") {
        await env.DB.prepare("UPDATE users SET suspended_at = 2 WHERE id = ?")
          .bind(CANDIDATE)
          .run();
      } else if (state === "unassigned") {
        await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
          .bind(CANDIDATE)
          .run();
      }

      const response = await patch(
        state === "missing" ? "ffffffffffffffffffffffffffffffff" : CANDIDATE
      );

      expect(response.status).toBe(state === "missing" ? 404 : 409);
      await expect(response.json()).resolves.toMatchObject(
        state === "missing"
          ? { error: "User not found" }
          : { code: "user_inactive", reason_code: "user_inactive" }
      );
      await expectUnchanged(row);
    }
  );

  it("preserves the membership error ahead of missing candidate launch permissions", async () => {
    const row = await saveAutomation("mixed");
    await customRole(CANDIDATE, []);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, CANDIDATE)
      .run();

    const response = await patch(CANDIDATE);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "automation_action_denied",
      reason_code: "not_member",
    });
    await expectUnchanged(row);
  });

  it.each(["own", "any"] as const)(
    "does not let an ordinary executor with manage.%s bypass lead or administrator authority",
    async (scope) => {
      const row = await saveAutomation("repoless");
      await customRole(EXECUTOR, [`automations.manage.${scope}`]);

      const response = await patch(CANDIDATE, EXECUTOR);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "automation_action_denied",
        reason_code: "not_owner_or_lead",
      });
      await expectUnchanged(row);
    }
  );

  it("requires the lead's management grant before checking candidate execution permissions", async () => {
    const row = await saveAutomation("mixed");
    await customRole(CANDIDATE, []);
    await env.DB.prepare(
      `DELETE FROM role_permissions WHERE role_id =
       (SELECT role_id FROM user_role_assignments WHERE user_id = ?)`
    )
      .bind(LEAD)
      .run();

    const response = await patch(CANDIDATE);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "automation_action_denied",
      reason_code: "missing_permission",
    });
    expect(await new AutomationStore(env.DB).getById(row.id)).toEqual(row);
    const audit = await env.DB.prepare(
      "SELECT action FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
    ).all();
    expect(audit.results).toEqual([]);
  });
});
