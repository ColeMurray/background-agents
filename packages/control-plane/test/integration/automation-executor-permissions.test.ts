import { ProjectStore } from "../../src/db/project-store";
import { isAutomationExecutionAuthorized } from "../../src/automation/authorization-guard";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";
import {
  assignCustomRole as customRole,
  seedEnvironment,
  seedTeam,
} from "./ownership-test-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const CANDIDATE = "33333333333333333333333333333333";
const TEAM = "team_executor_permissions";
const ENVIRONMENT = "env_executor_permissions";
const REPOSITORY = {
  repo_owner: "acme/group",
  repo_name: "direct",
  repo_id: 701,
  base_branch: "main",
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

function patch(userId: string, callerId = LEAD) {
  return serviceFetch("https://cp.test/automations/executor-permissions", {
    as: { userId: callerId, role: "member" },
    method: "PATCH",
    body: JSON.stringify({ userId }),
  });
}

async function saveAutomation(target: string) {
  const store = new AutomationStore(env.DB);
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, schedule_cron, model, created_by, user_id, created_at, updated_at)
     VALUES ('executor-permissions', ?, 'Saved executor permissions', 'Run tests', '0 9 * * *',
       'anthropic/claude-sonnet-4-6', ?, ?, 1, 1)`
  )
    .bind(TEAM, EXECUTOR, EXECUTOR)
    .run();
  if (target === "environment" || target === "mixed") {
    await seedEnvironment(ENVIRONMENT, TEAM, [
      { ...REPOSITORY, position: 0, repo_name: "environment-member", repo_id: 702 },
    ]);
  }
  const statements = [
    ...store.bindRepositoryInserts(
      "executor-permissions",
      target === "direct" || target === "mixed" ? [REPOSITORY] : [],
      1
    ),
    ...store.bindEnvironmentInserts(
      "executor-permissions",
      target === "environment" || target === "mixed" ? [ENVIRONMENT] : [],
      1
    ),
  ];
  if (statements.length > 0) await sqlDatabase(env.DB).batch(statements);
  return (await store.getById("executor-permissions"))!;
}

async function expectUnchanged(row: AutomationRow) {
  expect(await new AutomationStore(env.DB).getById(row.id)).toEqual(row);
  const audit = await env.DB.prepare(
    "SELECT action FROM authorization_audit_events WHERE action = 'automation.executor_changed'"
  ).all();
  expect(audit.results).toEqual([]);
}

async function expectDenied(response: Response, row: AutomationRow, code: string, reason: string) {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code, reason_code: reason });
  await expectUnchanged(row);
}

describe("automation executor launch permissions (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, CANDIDATE]) await seedActiveUser(userId);
    await seedTeam(TEAM, [
      [EXECUTOR, "member"],
      [LEAD, "lead"],
      [CANDIDATE, "member"],
    ]);
    await customRole(LEAD, ["automations.manage.own"]);
  });
  afterEach(cleanD1Tables);

  it.each(["preflight", "commit", "allowed"])(
    "checks subscribed project access during executor reassignment: %s",
    async (stage) => {
      await saveAutomation("repoless");
      const project = await new ProjectStore(env.DB).create(
        { name: "Executor project", slug: "executor-project", ownerTeamId: TEAM },
        { userId: EXECUTOR, requestId: "setup" }
      );
      await env.DB.prepare("UPDATE automations SET project_id=? WHERE id='executor-permissions'")
        .bind(project.id)
        .run();
      const store = new AutomationStore(env.DB);
      const row = (await store.getById("executor-permissions"))!;
      await customRole(
        CANDIDATE,
        stage === "preflight" ? ["sessions.create"] : ["sessions.create", "projects.read"]
      );
      if (stage === "preflight") {
        await expectDenied(
          await patch(CANDIDATE),
          row,
          "automation_executor_unauthorized",
          "execution_authorization_denied"
        );
      } else if (stage === "commit") {
        expect(
          await isAutomationExecutionAuthorized(env.DB, {
            automationId: row.id,
            executionUserId: CANDIDATE,
            requiresRepositoryUse: false,
            requiresEnvironmentUse: false,
          })
        ).toBe(true);
        await env.DB.prepare(
          "DELETE FROM role_permissions WHERE permission_id='projects.read' AND role_id=(SELECT role_id FROM user_role_assignments WHERE user_id=?)"
        )
          .bind(CANDIDATE)
          .run();
        const [result] = await sqlDatabase(env.DB).batch([
          store.bindExecutorChange(row, CANDIDATE, LEAD),
        ]);
        expect(result.meta.changes).toBe(0);
        await expectUnchanged(row);
      } else {
        expect((await patch(CANDIDATE)).status).toBe(200);
        expect((await store.getById(row.id))?.user_id).toBe(CANDIDATE);
      }
    }
  );

  it.each([
    { target: "repoless", missingPermission: "sessions.create" },
    { target: "direct", missingPermission: "repositories.use" },
    { target: "environment", missingPermission: "environments.use" },
    { target: "mixed", missingPermission: "repositories.use" },
    { target: "mixed", missingPermission: "environments.use" },
  ] as const)(
    "rejects $target reassignment without $missingPermission before mutation or audit",
    async ({ target, missingPermission }) => {
      const row = await saveAutomation(target);
      await customRole(CANDIDATE, [
        ...LAUNCH_PERMISSIONS.filter((permission) => permission !== missingPermission),
        "automations.read",
        "automations.manage.any",
        "automations.trigger.any",
      ]);
      await expectDenied(
        await patch(CANDIDATE),
        row,
        "automation_executor_unauthorized",
        "execution_authorization_denied"
      );
    }
  );

  it.each(TARGETS)(
    "accepts $target executors with exactly the required launch permissions",
    async ({ target, permissions }) => {
      const row = await saveAutomation(target);
      await customRole(CANDIDATE, permissions);
      const store = new AutomationStore(env.DB);
      const repositories = await store.getRepositoriesForAutomation(row.id);
      const environments = await store.getEnvironmentsForAutomation(row.id);
      const response = await patch(CANDIDATE);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        automation: {
          id: row.id,
          ownerTeamId: TEAM,
          userId: CANDIDATE,
          capabilities: { canManage: true, canRead: false },
        },
      });
      expect(await store.getById(row.id)).toEqual({
        ...row,
        user_id: CANDIDATE,
        updated_at: expect.any(Number),
      });
      expect(await store.getRepositoriesForAutomation(row.id)).toEqual(repositories);
      expect(await store.getEnvironmentsForAutomation(row.id)).toEqual(environments);
    }
  );

  it("revalidates same-ID executors before the no-op", async () => {
    const row = await saveAutomation("mixed");
    await customRole(EXECUTOR, ["sessions.create", "environments.use"]);
    await expectDenied(
      await patch(EXECUTOR),
      row,
      "automation_executor_unauthorized",
      "execution_authorization_denied"
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

  it("preserves membership denial ahead of missing launch permissions", async () => {
    const row = await saveAutomation("mixed");
    await customRole(CANDIDATE, []);
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(TEAM, CANDIDATE)
      .run();
    await expectDenied(await patch(CANDIDATE), row, "automation_action_denied", "not_member");
  });

  it("does not let manage.any bypass reassignment authority", async () => {
    const row = await saveAutomation("repoless");
    await customRole(EXECUTOR, ["automations.manage.any"]);
    await expectDenied(
      await patch(CANDIDATE, EXECUTOR),
      row,
      "automation_action_denied",
      "not_owner_or_lead"
    );
  });

  describe("guarded write after preflight", () => {
    function revoke(userId: string, permission: PermissionId) {
      return env.DB.prepare(
        `DELETE FROM role_permissions WHERE permission_id = ?
           AND role_id = (SELECT role_id FROM user_role_assignments WHERE user_id = ?)`
      )
        .bind(permission, userId)
        .run();
    }

    async function write(row: AutomationRow, actorUserId = LEAD) {
      const [result] = await sqlDatabase(env.DB).batch([
        new AutomationStore(env.DB).bindExecutorChange(row, CANDIDATE, actorUserId),
      ]);
      return result.meta.changes;
    }

    it("commits when caller authority and candidate launch permissions still hold", async () => {
      const row = await saveAutomation("mixed");
      await customRole(CANDIDATE, LAUNCH_PERMISSIONS);
      expect(await write(row)).toBe(1);
      expect((await new AutomationStore(env.DB).getById(row.id))?.user_id).toBe(CANDIDATE);
    });

    it.each([
      [
        "the caller is demoted from lead",
        () =>
          env.DB.prepare("UPDATE team_memberships SET role = 'member' WHERE user_id = ?")
            .bind(LEAD)
            .run(),
      ],
      ["the caller loses management permission", () => revoke(LEAD, "automations.manage.own")],
      ["the candidate loses a target permission", () => revoke(CANDIDATE, "environments.use")],
    ])("refuses the write when %s", async (_change, change) => {
      const row = await saveAutomation("mixed");
      await customRole(CANDIDATE, LAUNCH_PERMISSIONS);
      await change();
      expect(await write(row)).toBe(0);
      expect(await new AutomationStore(env.DB).getById(row.id)).toEqual(row);
    });

    it("derives target requirements from the targets stored at write time", async () => {
      const row = await saveAutomation("direct");
      await customRole(CANDIDATE, ["sessions.create", "repositories.use"]);
      // A concurrent edit adds an environment the candidate cannot use.
      await seedEnvironment(ENVIRONMENT, TEAM, [{ ...REPOSITORY, position: 0 }]);
      await sqlDatabase(env.DB).batch(
        new AutomationStore(env.DB).bindEnvironmentInserts(row.id, [ENVIRONMENT], 2)
      );
      expect(await write(row)).toBe(0);
      expect((await new AutomationStore(env.DB).getById(row.id))?.user_id).toBe(EXECUTOR);
    });
  });

  it("requires caller management permission before candidate checks", async () => {
    const row = await saveAutomation("mixed");
    await customRole(CANDIDATE, []);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id = (SELECT role_id FROM user_role_assignments WHERE user_id = ?)"
    )
      .bind(LEAD)
      .run();
    await expectDenied(
      await patch(CANDIDATE),
      row,
      "automation_action_denied",
      "missing_permission"
    );
  });
});
