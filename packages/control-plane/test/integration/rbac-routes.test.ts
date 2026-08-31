import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../../src/authorization/service";
import { UserStore } from "../../src/db/user-store";
import { mergeUsers } from "../../src/db/user-merge";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

describe("RBAC routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  async function seedOwner(): Promise<string> {
    expect((await serviceFetch("https://cp.test/me/authorization")).status).toBe(200);
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{
      id: string;
    }>();
    if (!user) throw new Error("Browser user was not seeded");
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
    )
      .bind(user.id)
      .run();
    return user.id;
  }

  it("keeps ordinary browser users as Member without an Owner assignment", async () => {
    const first = await serviceFetch("https://cp.test/me/authorization", {
      initialUserRole: "member",
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      suspendedAt: null,
      role: { key: "member" },
    });
  });

  it("assigns Member to identities created after the migration boundary", async () => {
    const user = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "New Member",
      email: "member@example.com",
      emailVerified: true,
    });

    const assignment = await env.DB.prepare(
      `SELECT r.key FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
    )
      .bind(user.id)
      .first();
    expect(assignment).toEqual({ key: "member" });
  });

  it("assigns Member at the database boundary for Better Auth and old-worker inserts", async () => {
    const userId = "22222222222222222222222222222222";
    await env.DB.prepare(
      `INSERT INTO users
        (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
       VALUES (?, 'Direct User', 'direct@example.com', 1, NULL, 1, 1)`
    )
      .bind(userId)
      .run();

    expect(
      await env.DB.prepare(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
      )
        .bind(userId)
        .first()
    ).toEqual({ key: "member" });
  });

  it("suspends an emailed member without an Owner assignment", async () => {
    await serviceFetch("https://cp.test/me/authorization");
    const actor = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    const member = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Suspendable Member",
      email: "member@example.com",
      emailVerified: true,
    });
    const service = new AuthorizationService(sqlDatabase(env.DB));

    await service.replaceMemberStatus({
      targetUserId: member.id,
      suspended: true,
      actorUserId: actor!.id,
      requestId: "suspend-without-bootstrap",
    });

    await expect(service.getEffectiveAuthorization(member.id)).resolves.toMatchObject({
      suspendedAt: expect.any(Number),
    });
  });

  it("fails closed when an existing user has no role assignment", async () => {
    await serviceFetch("https://cp.test/me/authorization");
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
      .bind(user!.id)
      .run();

    const response = await serviceFetch("https://cp.test/me/authorization");
    const personalRoute = await serviceFetch("https://cp.test/keyboard-shortcuts");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "assignment_required" });
    expect(personalRoute.status).toBe(403);
    await expect(personalRoute.json()).resolves.toMatchObject({ code: "assignment_required" });
    expect(
      await env.DB.prepare("SELECT * FROM user_role_assignments WHERE user_id = ?")
        .bind(user!.id)
        .first()
    ).toBeNull();
  });

  it("uses code-owned permissions for built-in role authorization", async () => {
    await serviceFetch("https://cp.test/me/authorization", { initialUserRole: "member" });
    const member = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    const permission = "workspace.roles.read";
    await env.DB.prepare(
      "INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_builtin_member', ?)"
    )
      .bind(permission)
      .run();

    try {
      const authorization = await new AuthorizationService(
        sqlDatabase(env.DB)
      ).getEffectiveAuthorization(member!.id);
      expect(authorization.permissions).not.toContain(permission);
      expect((await serviceFetch("https://cp.test/roles")).status).toBe(403);
      const audit = await env.DB.prepare(
        `SELECT principal_kind, actor_user_id_snapshot, action, resource_type, resource_id,
                reason_code, operation_result, metadata_json
         FROM authorization_audit_events
         WHERE action = 'authorization.request_denied' AND resource_id = '/roles'`
      ).first<{
        principal_kind: string;
        actor_user_id_snapshot: string;
        action: string;
        resource_type: string;
        resource_id: string;
        reason_code: string;
        operation_result: string;
        metadata_json: string;
      }>();
      expect(audit).toMatchObject({
        principal_kind: "user",
        actor_user_id_snapshot: member!.id,
        action: "authorization.request_denied",
        resource_type: "http_route",
        resource_id: "/roles",
        reason_code: "permission_required",
        operation_result: "denied",
      });
      expect(JSON.parse(audit!.metadata_json)).toMatchObject({
        httpMethod: "GET",
        httpPath: "/roles",
        httpStatus: 403,
        requiredPermission: permission,
        responseCode: "permission_required",
      });
    } finally {
      await env.DB.prepare(
        "DELETE FROM role_permissions WHERE role_id = 'role_builtin_member' AND permission_id = ?"
      )
        .bind(permission)
        .run();
    }
  });

  it("never resolves ownership transfer from a custom role", async () => {
    await serviceFetch("https://cp.test/me/authorization");
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    const roleId = "role_custom_owner";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'Custom Owner', 'custom owner', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES (?, 'workspace.roles.read'), (?, 'workspace.transfer_ownership')`
      ).bind(roleId, roleId),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        roleId,
        user!.id
      ),
    ]);

    const authorization = await new AuthorizationService(
      sqlDatabase(env.DB)
    ).getEffectiveAuthorization(user!.id);
    expect(authorization.permissions).toContain("workspace.roles.read");
    expect(authorization.permissions).not.toContain("workspace.transfer_ownership");
  });

  it("requires sessions.create in addition to parent collaboration when spawning a child", async () => {
    await serviceFetch("https://cp.test/me/authorization");
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    const roleId = "role_child_collaborator";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'Child Collaborator', 'child collaborator', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'sessions.collaborate')"
      ).bind(roleId),
      env.DB.prepare(`UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?`).bind(
        roleId,
        user!.id
      ),
    ]);

    const response = await serviceFetch("https://cp.test/sessions/parent/children", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Investigate" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.create",
    });
  });

  it("denies sensitive business mutations to Viewer", async () => {
    await serviceFetch("https://cp.test/me/authorization");
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
    )
      .bind(user!.id)
      .run();

    const response = await serviceFetch("https://cp.test/secrets", {
      method: "PUT",
      body: JSON.stringify({ secrets: { SHOULD_NOT_WRITE: "secret" } }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "global_secrets.manage",
    });

    await env.DB.prepare(
      `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at)
       VALUES ('viewer-session', 'acme', 'app', 'completed', 1, 1)`
    ).run();
    const sessionDelete = await serviceFetch("https://cp.test/sessions/viewer-session", {
      method: "DELETE",
    });
    expect(sessionDelete.status).toBe(403);
    await expect(sessionDelete.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.delete",
    });

    const read = await serviceFetch("https://cp.test/sessions/viewer-session");
    expect(read.status).not.toBe(403);

    for (const [path, method, permission, body] of [
      ["/sessions", "POST", "sessions.create", { title: "Denied", model: "test/model" }],
      ["/sessions/viewer-session/prompt", "POST", "sessions.collaborate", { content: "Denied" }],
      ["/sessions/viewer-session/stop", "POST", "sessions.lifecycle", undefined],
      ["/sessions/viewer-session/sandbox-access", "GET", "sessions.sandbox_access", undefined],
      ["/skill-profiles", "GET", "skill_profiles.manage_own", undefined],
      ["/skill-profiles", "POST", "skill_profiles.manage_own", { name: "Denied", skillIds: [] }],
      ["/skill-profiles/profile-1", "PATCH", "skill_profiles.manage_own", { name: "Denied" }],
      ["/skill-profiles/profile-1", "DELETE", "skill_profiles.manage_own", undefined],
      ["/model-provider-accounts", "GET", "provider_accounts.read", undefined],
      ["/model-provider-account-defaults", "GET", "provider_accounts.read", undefined],
      ["/model-provider-accounts/legacy-credentials", "GET", "provider_accounts.read", undefined],
    ] as const) {
      const denied = await serviceFetch(`https://cp.test${path}`, {
        method,
        ...(body
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
      });
      expect(denied.status, path).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({
        code: "permission_required",
        permission,
      });
    }
  });

  it("allows Members to discover and delete sessions workspace-wide", async () => {
    await serviceFetch("https://cp.test/me/authorization", { initialUserRole: "member" });
    const member = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    const other = await new UserStore(sqlDatabase(env.DB)).createUser({ displayName: "Other" });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
         VALUES ('member-session', 'acme', 'app', 'completed', 1, 1, ?)`
      ).bind(member!.id),
      env.DB.prepare(
        `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
         VALUES ('other-session', 'acme', 'app', 'completed', 2, 2, ?)`
      ).bind(other.id),
      env.DB.prepare(
        `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
         VALUES ('unjoined-session', 'acme', 'app', 'completed', 3, 3, ?)`
      ).bind(other.id),
    ]);

    const listed = await serviceFetch("https://cp.test/sessions");
    const lifecycle = await serviceFetch("https://cp.test/sessions/other-session/stop", {
      method: "POST",
    });
    const sandboxAccess = await serviceFetch(
      "https://cp.test/sessions/other-session/sandbox-access"
    );
    const otherDelete = await serviceFetch("https://cp.test/sessions/other-session", {
      method: "DELETE",
    });
    const ownDelete = await serviceFetch("https://cp.test/sessions/member-session", {
      method: "DELETE",
    });

    expect(listed.status).toBe(200);
    expect(lifecycle.status).not.toBe(403);
    expect(sandboxAccess.status).not.toBe(403);
    await expect(listed.json()).resolves.toMatchObject({
      sessions: [{ id: "unjoined-session" }, { id: "other-session" }, { id: "member-session" }],
    });
    expect(otherDelete.status).toBe(200);
    expect(ownDelete.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM sessions WHERE id = 'other-session'").first()
    ).toBeNull();
  });

  it("does not let the last unsuspended Owner be suspended", async () => {
    await seedOwner();
    const owner = await env.DB.prepare(
      `SELECT u.id
       FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       WHERE r.key = 'owner'`
    ).first<{ id: string }>();
    expect(owner).not.toBeNull();

    const response = await serviceFetch(`https://cp.test/members/${owner!.id}/status`, {
      method: "PUT",
      body: JSON.stringify({ suspended: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(owner!.id).first()
    ).toEqual({ suspended_at: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.member_status_updated'"
      ).first()
    ).toEqual({ count: 1 });
  });

  it("lets an Owner suspend themselves when another unsuspended Owner exists", async () => {
    const ownerId = await seedOwner();
    const otherOwner = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Other Owner",
    });
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
    )
      .bind(otherOwner.id)
      .run();

    const response = await serviceFetch(`https://cp.test/members/${ownerId}/status`, {
      method: "PUT",
      body: JSON.stringify({ suspended: true }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(ownerId).first()
    ).toEqual({ suspended_at: expect.any(Number) });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.member_status_updated'"
      ).first()
    ).toEqual({ count: 1 });
  });

  it("lets an Owner demote themselves when another unsuspended Owner exists", async () => {
    const ownerId = await seedOwner();
    const otherOwner = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Other Owner",
    });
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
    )
      .bind(otherOwner.id)
      .run();

    const response = await serviceFetch(`https://cp.test/members/${ownerId}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId: "role_builtin_administrator" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.member_role_updated'"
      ).first()
    ).toEqual({ count: 1 });
  });

  it("does not let the last unsuspended Owner demote themselves", async () => {
    const ownerId = await seedOwner();

    const response = await serviceFetch(`https://cp.test/members/${ownerId}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId: "role_builtin_administrator" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
      )
        .bind(ownerId)
        .first()
    ).toEqual({ key: "owner" });
  });

  it.each(["role", "status"] as const)(
    "rejects malformed percent encoding in member %s routes",
    async (operation) => {
      await seedOwner();

      const response = await serviceFetch(`https://cp.test/members/%/${operation}`, {
        method: "PUT",
        body: JSON.stringify(
          operation === "role" ? { roleId: "role_builtin_member" } : { suspended: true }
        ),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid user ID" });
    }
  );

  it("requires an explicit unsuspended Owner assignment before merging an Owner", async () => {
    const store = new UserStore(sqlDatabase(env.DB));
    const survivor = await store.createUser({ displayName: "Survivor" });
    const loser = await store.createUser({ displayName: "Owner" });
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(survivor.id),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
      ).bind(loser.id),
    ]);

    await expect(
      mergeUsers(sqlDatabase(env.DB), {
        survivorId: survivor.id,
        loserId: loser.id,
        dryRun: false,
      })
    ).rejects.toThrow("Resolve conflicting user roles before merging");
  });

  it("rejects privileged mutations when the actor authorization changes", async () => {
    const ownerId = await seedOwner();
    const member = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Target Member",
    });
    const service = new AuthorizationService(sqlDatabase(env.DB));
    await service.requirePermission(ownerId, "workspace.members.manage");
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = ?"
    )
      .bind(ownerId)
      .run();
    await expect(
      service.replaceMemberRole({
        targetUserId: member.id,
        roleId: "role_builtin_administrator",
        actorUserId: ownerId,
        requestId: "stale-member-role-request",
      })
    ).rejects.toThrow("Actor authorization changed");
    await expect(
      service.replaceMemberStatus({
        targetUserId: member.id,
        suspended: true,
        actorUserId: ownerId,
        requestId: "stale-member-request",
      })
    ).rejects.toThrow("Actor authorization changed");

    expect(await service.getEffectiveAuthorization(member.id)).toMatchObject({
      role: { key: "member" },
    });
    expect(
      await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(member.id).first()
    ).toEqual({ suspended_at: null });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM authorization_audit_events
         WHERE request_id IN (
            'stale-member-role-request', 'stale-member-request'
         )`
      ).first()
    ).toEqual({ count: 2 });
  });

  it("returns authorization unavailable for an unexpected mutation database failure", async () => {
    await seedOwner();
    await env.DB.prepare(
      `CREATE TRIGGER fail_member_audit
       BEFORE INSERT ON authorization_audit_events
       WHEN NEW.action = 'workspace.member_status_updated'
       BEGIN
         SELECT RAISE(ABORT, 'forced database failure');
       END`
    ).run();

    try {
      const member = await new UserStore(sqlDatabase(env.DB)).createUser({ displayName: "Member" });
      const response = await serviceFetch(`https://cp.test/members/${member.id}/status`, {
        method: "PUT",
        body: JSON.stringify({ suspended: true }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Authorization unavailable",
        code: "authorization_unavailable",
      });
      expect(
        await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(member.id).first()
      ).toEqual({ suspended_at: null });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.member_status_updated'"
        ).first()
      ).toEqual({ count: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_member_audit").run();
    }
  });

  it("rejects suspended users at the backend after reauthentication", async () => {
    await seedOwner();
    await env.DB.prepare("UPDATE users SET suspended_at = 1").run();

    const response = await serviceFetch("https://cp.test/repos");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "active_user_required",
    });
  });
});
