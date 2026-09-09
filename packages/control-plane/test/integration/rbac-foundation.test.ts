import { env } from "cloudflare:test";
import {
  BUILT_IN_ROLE_REGISTRY,
  PERMISSION_IDS,
  permissionsForBuiltInRole,
} from "@open-inspect/shared/rbac";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorizationStore } from "../../src/db/authorization-store";
import { AuthorizationService } from "../../src/authorization/service";
import { cleanD1Tables } from "./cleanup";
import { insertAuthSession, insertCanonicalUser } from "./identity-seed-helpers";

const ACTOR_ID = "11111111111111111111111111111111";
const TARGET_ID = "22222222222222222222222222222222";

beforeEach(cleanD1Tables);

describe("RBAC foundation migration", () => {
  it("seeds built-in roles without persisting their code-owned permissions", async () => {
    const roles = await env.DB.prepare(
      "SELECT id, key FROM roles WHERE is_system = 1 ORDER BY key"
    ).all<{ id: string; key: string }>();

    expect(roles.results).toEqual(
      Object.values(BUILT_IN_ROLE_REGISTRY).sort((left, right) => left.key.localeCompare(right.key))
    );

    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.is_system = 1`
      ).first()
    ).toEqual({ count: 0 });
    expect(permissionsForBuiltInRole("owner")).toHaveLength(PERMISSION_IDS.length);
  });

  it("rejects non-canonical system role identities and reserved IDs used as custom roles", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_system_alias', NULL, 'Alias', 'alias', 1)`
      ).run()
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        `UPDATE roles SET key = NULL, is_system = 0
         WHERE id = 'role_builtin_owner'`
      ).run()
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        `UPDATE roles SET key = NULL
         WHERE id = 'role_builtin_owner'`
      ).run()
    ).rejects.toThrow();
  });

  it("classifies missing roles and members through real D1 mutation SQL", async () => {
    await insertCanonicalUser({ id: ACTOR_ID, email: "owner@example.com" });
    await insertCanonicalUser({ id: TARGET_ID, email: "member@example.com" });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.owner.id, ACTOR_ID)
      .run();
    const store = new AuthorizationStore(env.DB);

    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        roleId: "role_missing",
        requestId: "missing-role",
        now: 100,
      })
    ).resolves.toEqual({ status: "role_not_found" });
    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: "33333333333333333333333333333333",
        roleId: BUILT_IN_ROLE_REGISTRY.viewer.id,
        requestId: "missing-role-target",
        now: 101,
      })
    ).resolves.toEqual({ status: "member_not_found" });
    await expect(
      store.replaceMemberStatus({
        actorUserId: ACTOR_ID,
        targetUserId: "33333333333333333333333333333333",
        suspended: true,
        requestId: "missing-status-target",
        now: 102,
      })
    ).resolves.toEqual({ status: "member_not_found" });

    const rejectedAudits = await env.DB.prepare(
      `SELECT request_id, reason_code, operation_result, metadata_json
       FROM authorization_audit_events
       WHERE request_id IN ('missing-role', 'missing-role-target', 'missing-status-target')
       ORDER BY request_id`
    ).all<{
      request_id: string;
      reason_code: string;
      operation_result: string;
      metadata_json: string;
    }>();
    expect(
      rejectedAudits.results.map((audit) => ({
        ...audit,
        metadata_json: JSON.parse(audit.metadata_json),
      }))
    ).toEqual([
      {
        request_id: "missing-role",
        reason_code: "role_not_found",
        operation_result: "rejected",
        metadata_json: {
          before: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
          requested: { roleId: "role_missing" },
          after: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
        },
      },
      {
        request_id: "missing-role-target",
        reason_code: "member_not_found",
        operation_result: "rejected",
        metadata_json: {
          before: { roleId: null },
          requested: { roleId: BUILT_IN_ROLE_REGISTRY.viewer.id },
          after: { roleId: null },
        },
      },
      {
        request_id: "missing-status-target",
        reason_code: "member_not_found",
        operation_result: "rejected",
        metadata_json: {
          before: { suspended: null, suspendedAt: null },
          requested: { suspended: true },
          after: { suspended: null, suspendedAt: null },
        },
      },
    ]);

    const service = new AuthorizationService(env.DB);
    await expect(
      service.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        roleId: "role_missing",
        requestId: "missing-role-service",
      })
    ).rejects.toMatchObject({ status: 404, code: "role_not_found" });
    await expect(
      service.replaceMemberStatus({
        actorUserId: ACTOR_ID,
        targetUserId: "33333333333333333333333333333333",
        suspended: true,
        requestId: "missing-member-service",
      })
    ).rejects.toMatchObject({ status: 404, code: "member_not_found" });
  });

  it("applies and audits a member mutation through real D1 SQL", async () => {
    await insertCanonicalUser({ id: ACTOR_ID, email: "owner@example.com" });
    await insertCanonicalUser({ id: TARGET_ID, email: "member@example.com" });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.owner.id, ACTOR_ID)
      .run();
    const store = new AuthorizationStore(env.DB);

    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        roleId: BUILT_IN_ROLE_REGISTRY.viewer.id,
        requestId: "apply-role",
        now: 200,
      })
    ).resolves.toEqual({ status: "applied" });
    await expect(
      env.DB.prepare(
        `SELECT action, request_id, target_user_id_snapshot, operation_result, metadata_json
         FROM authorization_audit_events WHERE request_id = 'apply-role'`
      ).first()
    ).resolves.toEqual({
      action: "workspace.member_role_updated",
      request_id: "apply-role",
      target_user_id_snapshot: TARGET_ID,
      operation_result: "applied",
      metadata_json: JSON.stringify({
        before: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
        requested: { roleId: BUILT_IN_ROLE_REGISTRY.viewer.id },
        after: { roleId: BUILT_IN_ROLE_REGISTRY.viewer.id },
      }),
    });

    await expect(
      store.replaceMemberStatus({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        suspended: true,
        requestId: "apply-status",
        now: 201,
      })
    ).resolves.toEqual({ status: "applied" });
    const statusAudit = await env.DB.prepare(
      `SELECT operation_result, metadata_json
       FROM authorization_audit_events WHERE request_id = 'apply-status'`
    ).first<{ operation_result: string; metadata_json: string }>();
    expect(statusAudit?.operation_result).toBe("applied");
    expect(JSON.parse(statusAudit!.metadata_json)).toEqual({
      before: { suspended: false, suspendedAt: null },
      requested: { suspended: true },
      after: { suspended: true, suspendedAt: 201 },
    });
  });

  it("returns audit-insert outcomes for no-op mutations without touching state or sessions", async () => {
    await insertCanonicalUser({ id: ACTOR_ID, email: "owner@example.com" });
    await insertCanonicalUser({ id: TARGET_ID, email: "member@example.com" });
    await env.DB.batch([
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        BUILT_IN_ROLE_REGISTRY.owner.id,
        ACTOR_ID
      ),
      env.DB.prepare("UPDATE users SET suspended_at = 150, updated_at = 150 WHERE id = ?").bind(
        TARGET_ID
      ),
    ]);
    await insertAuthSession({ id: "target-session", userId: TARGET_ID });
    const store = new AuthorizationStore(env.DB);

    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        roleId: BUILT_IN_ROLE_REGISTRY.member.id,
        requestId: "same-role",
        now: 200,
      })
    ).resolves.toEqual({ status: "no_op" });
    await expect(
      store.replaceMemberStatus({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        suspended: true,
        requestId: "same-status",
        now: 201,
      })
    ).resolves.toEqual({ status: "no_op" });

    expect(
      await env.DB.prepare("SELECT suspended_at, updated_at FROM users WHERE id = ?")
        .bind(TARGET_ID)
        .first()
    ).toEqual({ suspended_at: 150, updated_at: 150 });
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE id = 'target-session'").first()
    ).toEqual({ id: "target-session" });
    const audits = await env.DB.prepare(
      `SELECT request_id, reason_code, operation_result, metadata_json
       FROM authorization_audit_events
       WHERE request_id IN ('same-role', 'same-status') ORDER BY request_id`
    ).all<{ request_id: string; operation_result: string; metadata_json: string }>();
    expect(
      audits.results.map((audit) => ({
        ...audit,
        metadata_json: JSON.parse(audit.metadata_json),
      }))
    ).toEqual([
      {
        request_id: "same-role",
        reason_code: "member_role_unchanged",
        operation_result: "no_op",
        metadata_json: {
          before: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
          requested: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
          after: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
        },
      },
      {
        request_id: "same-status",
        reason_code: "member_status_unchanged",
        operation_result: "no_op",
        metadata_json: {
          before: { suspended: true, suspendedAt: 150 },
          requested: { suspended: true },
          after: { suspended: true, suspendedAt: 150 },
        },
      },
    ]);
  });

  it("audits denied actor revalidation and rejected owner conflicts without changing state", async () => {
    await insertCanonicalUser({ id: ACTOR_ID, email: "owner@example.com" });
    await insertCanonicalUser({ id: TARGET_ID, email: "member@example.com" });
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.owner.id, ACTOR_ID)
      .run();
    const store = new AuthorizationStore(env.DB);

    await env.DB.prepare("UPDATE users SET suspended_at = 50 WHERE id = ?").bind(ACTOR_ID).run();
    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        roleId: BUILT_IN_ROLE_REGISTRY.viewer.id,
        requestId: "actor-revalidation",
        now: 100,
      })
    ).resolves.toEqual({ status: "actor_authorization_changed" });

    await env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(ACTOR_ID).run();
    await expect(
      store.replaceMemberRole({
        actorUserId: ACTOR_ID,
        targetUserId: ACTOR_ID,
        roleId: BUILT_IN_ROLE_REGISTRY.member.id,
        requestId: "owner-conflict",
        now: 101,
      })
    ).resolves.toEqual({ status: "conflict" });

    expect(
      await env.DB.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?")
        .bind(TARGET_ID)
        .first()
    ).toEqual({ role_id: BUILT_IN_ROLE_REGISTRY.member.id });
    expect(
      await env.DB.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?")
        .bind(ACTOR_ID)
        .first()
    ).toEqual({ role_id: BUILT_IN_ROLE_REGISTRY.owner.id });

    const audits = await env.DB.prepare(
      `SELECT request_id, reason_code, operation_result, metadata_json
       FROM authorization_audit_events
       WHERE request_id IN ('actor-revalidation', 'owner-conflict') ORDER BY request_id`
    ).all<{
      request_id: string;
      reason_code: string;
      operation_result: string;
      metadata_json: string;
    }>();
    expect(
      audits.results.map((audit) => ({
        ...audit,
        metadata_json: JSON.parse(audit.metadata_json),
      }))
    ).toEqual([
      {
        request_id: "actor-revalidation",
        reason_code: "actor_authorization_changed",
        operation_result: "denied",
        metadata_json: {
          before: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
          requested: { roleId: BUILT_IN_ROLE_REGISTRY.viewer.id },
          after: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
        },
      },
      {
        request_id: "owner-conflict",
        reason_code: "owner_conflict",
        operation_result: "rejected",
        metadata_json: {
          before: { roleId: BUILT_IN_ROLE_REGISTRY.owner.id },
          requested: { roleId: BUILT_IN_ROLE_REGISTRY.member.id },
          after: { roleId: BUILT_IN_ROLE_REGISTRY.owner.id },
        },
      },
    ]);
  });
});
