import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../../src/authorization/service";
import { automationAuthorizationGuard } from "../../src/automation/authorization-guard";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { runGuardedBatch } from "../../src/db/guarded-write";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";

function automation(id: string, userId: string): AutomationRow {
  return {
    id,
    name: id,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: userId,
    user_id: userId,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

async function seedBrowser(role: "owner" | "member" = "member"): Promise<void> {
  const response = await serviceFetch("https://cp.test/me/authorization", {
    initialUserRole: role,
  });
  expect(response.status).toBe(200);
}

describe("automation router authorization", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("returns 404 for a missing automation before authority disclosure", async () => {
    await seedBrowser("member");

    const response = await serviceFetch("https://cp.test/automations/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
      initialUserRole: "member",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Automation not found" });

    const store = new AutomationStore(env.DB);
    await store.create(automation("deleted-automation", BROWSER_USER_ID));
    await store.softDelete("deleted-automation");
    const deleted = await serviceFetch("https://cp.test/automations/deleted-automation", {
      method: "DELETE",
      initialUserRole: "member",
    });
    expect(deleted.status).toBe(404);
    await expect(deleted.json()).resolves.toEqual({ error: "Automation not found" });
  });

  it("allows own management and denies another user's automation", async () => {
    await seedBrowser("member");
    const other = await new UserStore(sqlDatabase(env.DB)).createUser({ displayName: "Other" });
    const store = new AutomationStore(env.DB);
    await store.create(automation("own-automation", BROWSER_USER_ID));
    await store.create(automation("other-automation", other.id));

    const own = await serviceFetch("https://cp.test/automations/own-automation", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated own" }),
      initialUserRole: "member",
    });
    const denied = await serviceFetch("https://cp.test/automations/other-automation", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated other" }),
      initialUserRole: "member",
    });

    expect(own.status).toBe(200);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "automations.manage.own",
    });
    expect((await store.getById("other-automation"))?.name).toBe("other-automation");
  });

  it("denies users without manage permission", async () => {
    await seedBrowser("member");
    await new AutomationStore(env.DB).create(automation("viewer-target", BROWSER_USER_ID));
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
    )
      .bind(BROWSER_USER_ID)
      .run();

    const response = await serviceFetch("https://cp.test/automations/viewer-target", {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "automations.manage.own",
    });
  });

  it("retains body-derived target permission checks after route admission", async () => {
    await seedBrowser("member");
    await new AutomationStore(env.DB).create(automation("target-permission", BROWSER_USER_ID));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system, revision)
         VALUES ('role_manage_only', NULL, 'Manage Only', 'manage only', NULL, 0, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_manage_only', 'automations.manage.own')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_manage_only' WHERE user_id = ?"
      ).bind(BROWSER_USER_ID),
    ]);

    const response = await serviceFetch("https://cp.test/automations/target-permission", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositories: [] }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "repositories.use",
    });
  });

  it("denies bot services before handler dispatch", async () => {
    await seedBrowser("owner");
    await new AutomationStore(env.DB).create(automation("service-target", BROWSER_USER_ID));

    const response = await serviceFetch("https://cp.test/automations/service-target", {
      method: "DELETE",
      service: "slack-bot",
      actor: "slack:U-AUTOMATION",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_capability_required" });
    expect(await new AutomationStore(env.DB).getById("service-target")).not.toBeNull();
  });
});

describe("automation transactional authorization", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("rolls back a write when the automation was deleted after admission", async () => {
    await seedBrowser("owner");
    const db = sqlDatabase(env.DB);
    const store = new AutomationStore(db);
    await store.create(automation("deleted-race", BROWSER_USER_ID));
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(
      BROWSER_USER_ID
    );
    await store.softDelete("deleted-race");

    await expect(
      runGuardedBatch(
        db,
        [automationAuthorizationGuard("deleted-race", authorization, "manage")],
        [db.prepare("UPDATE automations SET name = 'stale-write' WHERE id = 'deleted-race'")]
      )
    ).rejects.toThrow();

    expect(
      await env.DB.prepare("SELECT name FROM automations WHERE id = 'deleted-race'").first()
    ).toEqual({ name: "deleted-race" });
  });

  it("rolls back a write when ownership changes after admission", async () => {
    await seedBrowser("member");
    const db = sqlDatabase(env.DB);
    const store = new AutomationStore(db);
    const other = await new UserStore(db).createUser({ displayName: "Other" });
    await store.create(automation("ownership-race", BROWSER_USER_ID));
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(
      BROWSER_USER_ID
    );
    await env.DB.prepare("UPDATE automations SET user_id = ? WHERE id = ?")
      .bind(other.id, "ownership-race")
      .run();

    await expect(
      runGuardedBatch(
        db,
        [automationAuthorizationGuard("ownership-race", authorization, "manage")],
        [db.prepare("UPDATE automations SET name = 'stale-write' WHERE id = 'ownership-race'")]
      )
    ).rejects.toThrow();

    expect((await store.getById("ownership-race"))?.name).toBe("ownership-race");
  });

  it("retains associations when target permission is revoked after admission", async () => {
    await seedBrowser("member");
    const db = sqlDatabase(env.DB);
    const store = new AutomationStore(db);
    await store.create(automation("permission-race", BROWSER_USER_ID));
    await env.DB.prepare(
      `INSERT INTO automation_repositories
        (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
       VALUES ('permission-race', 'acme', 'old', 1, 'main', 1, 1)`
    ).run();
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(
      BROWSER_USER_ID
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system, revision)
         VALUES ('role_manage_own', NULL, 'Manage Own', 'manage own', NULL, 0, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_manage_own', 'automations.manage.own')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_manage_own' WHERE user_id = ?"
      ).bind(BROWSER_USER_ID),
    ]);

    await expect(
      runGuardedBatch(
        db,
        [
          automationAuthorizationGuard("permission-race", authorization, "manage", [
            "repositories.use",
          ]),
        ],
        [
          ...store.bindReplaceRepositories(
            "permission-race",
            [{ repo_owner: "acme", repo_name: "new", repo_id: 2, base_branch: "main" }],
            2
          ),
        ]
      )
    ).rejects.toThrow();

    await expect(store.getRepositoriesForAutomation("permission-race")).resolves.toMatchObject([
      { repo_name: "old" },
    ]);
  });
});
