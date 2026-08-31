import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

const migration = () => {
  const entry = env.TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith("0072"));
  if (!entry) throw new Error("Migration 0072 not found in TEST_MIGRATIONS");
  return entry;
};

async function tableColumns(): Promise<string[]> {
  const result = await env.DB.prepare("PRAGMA table_info(authorization_audit_events)").all<{
    name: string;
  }>();
  return result.results.map((column) => column.name);
}

async function restoreMigration(): Promise<void> {
  if (!(await tableColumns()).includes("operation_result")) {
    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));
  }
}

beforeEach(cleanD1Tables);
afterEach(async () => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_default_role_audit").run();
  await restoreMigration();
  await cleanD1Tables();
});

describe("migration 0072: RBAC audit fidelity", () => {
  it("adds result metadata and atomically audits default role assignments", async () => {
    await env.DB.prepare("DROP TRIGGER assign_default_role_after_user_insert").run();
    await env.DB.prepare("ALTER TABLE authorization_audit_events DROP COLUMN metadata_json").run();
    await env.DB.prepare(
      "ALTER TABLE authorization_audit_events DROP COLUMN operation_result"
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER assign_default_role_after_user_insert
       AFTER INSERT ON users
       BEGIN
         INSERT INTO user_role_assignments (user_id, role_id)
         VALUES (NEW.id, 'role_builtin_member')
         ON CONFLICT(user_id) DO NOTHING;
       END`
    ).run();
    await env.DB.prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_service_snapshot,
         action, resource_type, reason_code)
       VALUES ('legacy-audit', 1, 'legacy-request', 'service', 'control-plane',
         'legacy.action', 'workspace', 'legacy')`
    ).run();

    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));

    expect(await tableColumns()).toEqual([
      "id",
      "occurred_at",
      "request_id",
      "principal_kind",
      "actor_user_id_snapshot",
      "actor_service_snapshot",
      "action",
      "resource_type",
      "resource_id",
      "target_user_id_snapshot",
      "reason_code",
      "operation_result",
      "metadata_json",
    ]);
    expect(
      await env.DB.prepare(
        "SELECT operation_result, metadata_json FROM authorization_audit_events WHERE id = 'legacy-audit'"
      ).first()
    ).toEqual({ operation_result: "applied", metadata_json: "{}" });

    await env.DB.prepare(
      `INSERT INTO users
        (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
       VALUES ('33333333333333333333333333333333', 'New User', NULL, 0, NULL, 500, 500)`
    ).run();

    const audit = await env.DB.prepare(
      `SELECT occurred_at, request_id, actor_service_snapshot, action, resource_id,
              target_user_id_snapshot, reason_code, operation_result, metadata_json
       FROM authorization_audit_events
       WHERE request_id = 'default-role:33333333333333333333333333333333'`
    ).first<Record<string, unknown>>();
    expect(audit).toMatchObject({
      occurred_at: 500,
      actor_service_snapshot: "database-trigger",
      action: "workspace.default_role_assigned",
      resource_id: "33333333333333333333333333333333",
      target_user_id_snapshot: "33333333333333333333333333333333",
      reason_code: "default_role",
      operation_result: "applied",
    });
    expect(JSON.parse(audit!.metadata_json as string)).toEqual({
      before: { roleId: null },
      requested: { roleId: "role_builtin_member" },
      after: { roleId: "role_builtin_member" },
    });
  });

  it("rolls back user creation when the default-role audit cannot be written", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_default_role_audit
       BEFORE INSERT ON authorization_audit_events
       WHEN NEW.action = 'workspace.default_role_assigned'
       BEGIN
         SELECT RAISE(ABORT, 'forced audit failure');
       END`
    ).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
         VALUES ('44444444444444444444444444444444', 'Failed User', NULL, 0, NULL, 600, 600)`
      ).run()
    ).rejects.toThrow("forced audit failure");
    expect(
      await env.DB.prepare(
        "SELECT id FROM users WHERE id = '44444444444444444444444444444444'"
      ).first()
    ).toBeNull();
  });
});
