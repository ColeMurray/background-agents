import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../../src/authorization/service";
import { UserStore } from "../../src/db/user-store";
import { mergeUsers } from "../../src/db/user-merge";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";
import { bindPermissionSetGuard } from "../../src/automation/authorization-guard";

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
    } finally {
      await env.DB.prepare(
        "DELETE FROM role_permissions WHERE role_id = 'role_builtin_member' AND permission_id = ?"
      )
        .bind(permission)
        .run();
    }
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
          (id, key, name, normalized_name, description, is_system, revision,
           created_by, updated_by, created_at, updated_at)
         VALUES (?, NULL, 'Child Collaborator', 'child collaborator', NULL, 0, 1, ?, ?, 1, 1)`
      ).bind(roleId, user!.id, user!.id),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, 'sessions.collaborate.any')"
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

  it("rolls back a command when the actor loses live permission", async () => {
    const ownerId = await seedOwner();
    const db = sqlDatabase(env.DB);
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(ownerId);
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?"
    )
      .bind(ownerId)
      .run();

    await expect(
      db.batch([
        bindPermissionSetGuard(db, authorization, ["automations.create"]),
        db.prepare("UPDATE users SET display_name = 'stale-write' WHERE id = ?").bind(ownerId),
      ])
    ).rejects.toThrow();

    expect(
      await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(ownerId).first()
    ).not.toEqual({ display_name: "stale-write" });
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
  });

  it("keeps Member session discovery open while deletion remains creator-only", async () => {
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
      env.DB.prepare(
        `INSERT INTO session_access
          (session_id, user_id, relation, state, generation, created_at)
         VALUES ('other-session', ?, 'participant', 'active', 1, 2)`
      ).bind(member!.id),
    ]);

    const listed = await serviceFetch("https://cp.test/sessions");
    const deniedDelete = await serviceFetch("https://cp.test/sessions/other-session", {
      method: "DELETE",
    });
    const ownDelete = await serviceFetch("https://cp.test/sessions/member-session", {
      method: "DELETE",
    });

    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      sessions: [{ id: "unjoined-session" }, { id: "other-session" }, { id: "member-session" }],
    });
    expect(deniedDelete.status).toBe(403);
    expect(ownDelete.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM sessions WHERE id = 'other-session'").first()
    ).toEqual({ id: "other-session" });
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
    ).toEqual({ count: 0 });
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

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(ownerId).first()
    ).toEqual({ suspended_at: expect.any(Number) });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.member_status_updated'"
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

  it("derives Owner bootstrap health from an unsuspended Owner assignment", async () => {
    const pending = await SELF.fetch("https://cp.test/health");
    await expect(pending.json()).resolves.toMatchObject({
      rbac: { ownerBootstrap: "owner_bootstrap_pending" },
    });

    const ownerId = await seedOwner();
    const complete = await SELF.fetch("https://cp.test/health");
    await expect(complete.json()).resolves.toMatchObject({
      rbac: { ownerBootstrap: "complete" },
    });

    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(ownerId).run();
    const suspended = await SELF.fetch("https://cp.test/health");
    await expect(suspended.json()).resolves.toMatchObject({
      rbac: { ownerBootstrap: "owner_bootstrap_pending" },
    });
  });

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

  it("manages custom roles and member assignments without authorization versions", async () => {
    await seedOwner();

    const create = await serviceFetch("https://cp.test/roles", {
      method: "POST",
      body: JSON.stringify({
        name: "Release Managers",
        description: "Can inspect and launch sessions",
        permissions: ["workspace.read", "repositories.read", "sessions.create"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(201);
    const role = (await create.json()) as { id: string; revision: number };
    expect(role.revision).toBe(1);

    const update = await serviceFetch(`https://cp.test/roles/${encodeURIComponent(role.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Release Operators",
        description: null,
        permissions: ["workspace.read", "repositories.read"],
      }),
      headers: { "Content-Type": "application/json", "If-Match": '"1"' },
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({ name: "Release Operators", revision: 2 });

    const stale = await serviceFetch(`https://cp.test/roles/${encodeURIComponent(role.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Stale", permissions: ["workspace.read"] }),
      headers: { "Content-Type": "application/json", "If-Match": '"1"' },
    });
    expect(stale.status).toBe(409);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM authorization_audit_events WHERE action = 'workspace.role_updated'`
      ).first()
    ).toEqual({ count: 1 });

    const member = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Member",
      email: "other@example.com",
      emailVerified: true,
    });
    const assign = await serviceFetch(`https://cp.test/members/${member.id}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId: role.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(assign.status).toBe(200);
    await expect(assign.json()).resolves.toMatchObject({
      role: { id: role.id },
    });

    const suspend = await serviceFetch(`https://cp.test/members/${member.id}/status`, {
      method: "PUT",
      body: JSON.stringify({ suspended: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(suspend.status).toBe(200);
    await expect(suspend.json()).resolves.toMatchObject({
      suspendedAt: expect.any(Number),
      permissions: [],
    });

    const restore = await serviceFetch(`https://cp.test/members/${member.id}/status`, {
      method: "PUT",
      body: JSON.stringify({ suspended: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({ suspendedAt: null });
  });

  it("rejects privileged mutations when the actor authorization changes", async () => {
    const ownerId = await seedOwner();
    const member = await new UserStore(sqlDatabase(env.DB)).createUser({
      displayName: "Target Member",
    });
    const service = new AuthorizationService(sqlDatabase(env.DB));
    await service.requirePermission(ownerId, "workspace.roles.manage");
    const editableRole = await service.createRole(
      { name: "Editable Role", permissions: ["workspace.read"] },
      ownerId,
      "setup-editable-role"
    );
    const deletableRole = await service.createRole(
      { name: "Deletable Role", permissions: ["workspace.read"] },
      ownerId,
      "setup-deletable-role"
    );

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = ?"
      ).bind(ownerId),
    ]);

    await expect(
      service.createRole(
        { name: "Stale Actor Role", permissions: ["workspace.read"] },
        ownerId,
        "stale-role-request"
      )
    ).rejects.toThrow("Actor authorization changed");
    await expect(
      service.replaceRole(
        editableRole.id,
        editableRole.revision,
        { name: "Edited By Stale Actor", permissions: ["workspace.read"] },
        ownerId,
        "stale-role-edit"
      )
    ).rejects.toThrow("Actor authorization changed");
    await expect(
      service.deleteRole(deletableRole.id, ownerId, "stale-role-delete")
    ).rejects.toThrow("Actor authorization changed");
    await expect(
      service.replaceMemberRole({
        targetUserId: member.id,
        roleId: editableRole.id,
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

    expect(
      await env.DB.prepare(
        "SELECT id FROM roles WHERE normalized_name = 'stale actor role'"
      ).first()
    ).toBeNull();
    expect(await service.getRole(editableRole.id)).toMatchObject({ name: "Editable Role" });
    expect(await service.getRole(deletableRole.id)).toMatchObject({ name: "Deletable Role" });
    expect(await service.getEffectiveAuthorization(member.id)).toMatchObject({
      role: { key: "member" },
    });
    expect(
      await env.DB.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(member.id).first()
    ).toEqual({ suspended_at: null });
  });

  it("returns a conflict for duplicate normalized role names", async () => {
    await seedOwner();
    const createRole = (name: string) =>
      serviceFetch("https://cp.test/roles", {
        method: "POST",
        body: JSON.stringify({ name, permissions: ["workspace.read"] }),
        headers: { "Content-Type": "application/json" },
      });

    expect((await createRole("Operators")).status).toBe(201);
    const duplicate = await createRole("operators");

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: "Role name already exists",
      code: "rbac_conflict",
    });
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
