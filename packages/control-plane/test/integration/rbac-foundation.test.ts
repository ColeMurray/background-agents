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
import { insertCanonicalUser } from "./identity-seed-helpers";

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
        `SELECT action, request_id, target_user_id_snapshot
         FROM authorization_audit_events WHERE request_id = 'apply-role'`
      ).first()
    ).resolves.toEqual({
      action: "workspace.member_role_updated",
      request_id: "apply-role",
      target_user_id_snapshot: TARGET_ID,
    });
  });
});
