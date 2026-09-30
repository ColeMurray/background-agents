import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionScopeStore } from "../../src/db/session-scope-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { TeamAuditStore } from "../../src/db/team-audit";
import { SessionAuditStore } from "../../src/db/session-audit";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  routeRequest,
  seedActiveUser,
  serviceFetch,
  serviceRequestHeaders,
  sqlDatabase,
} from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const COLLABORATOR = "22222222222222222222222222222222";

function request(path: string, method = "GET", body?: object, as?: string) {
  return serviceFetch(`${BASE}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(as ? { as: { userId: as, role: "member" } } : {}),
  });
}

async function session(id: string, parentSessionId?: string, userId: string | null = OWNER) {
  await new SessionIndexStore(env.DB).create({
    id,
    ownerTeamId: null,
    visibility: "workspace",
    title: id,
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    status: "created",
    userId,
    parentSessionId,
    repositories: [{ repoOwner: "acme", repoName: "web-app", repoId: 12345, baseBranch: "main" }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function grant(teamId: string) {
  await env.DB.prepare(
    "INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at) VALUES (?, ?, 'installation', ?)"
  )
    .bind(crypto.randomUUID(), teamId, Date.now())
    .run();
}

describe("session scope routes", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(COLLABORATOR);
    await request("/me/authorization");
  });

  it("moves every descendant to a granted team and audits the move", async () => {
    await session("root");
    await session("child", "root");
    await session("grandchild", "child");
    const team = await new TeamStore(env.DB).create({
      slug: "alpha",
      name: "Alpha",
      joinPolicy: "open",
    });
    await grant(team.id);
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);

    const moved = await request("/sessions/root/scope", "PUT", { teamId: team.id });
    expect(moved.status).toBe(200);
    for (const id of ["root", "child", "grandchild"]) {
      expect((await new SessionIndexStore(env.DB).get(id))?.ownerTeamId).toBe(team.id);
    }
    expect(await (await request(`/sessions?teamIds[]=${team.id}`)).json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: "root", ownerTeamId: team.id }),
      ]),
    });
    const audit = await env.DB.prepare(
      "SELECT resource_id, team_id, metadata_json FROM authorization_audit_events WHERE action = 'session.moved' ORDER BY resource_id"
    ).all<{ resource_id: string; team_id: string; metadata_json: string }>();
    expect(
      audit.results.map((row) => ({
        sessionId: row.resource_id,
        teamId: row.team_id,
        metadata: JSON.parse(row.metadata_json),
      }))
    ).toEqual(
      ["child", "grandchild", "root"].map((sessionId) => ({
        sessionId,
        teamId: team.id,
        metadata: {
          before: { teamId: null, visibility: "workspace" },
          requested: {},
          after: { teamId: team.id, visibility: "workspace" },
        },
      }))
    );
  });

  it("records each independently scoped child's actual source team on a cascade", async () => {
    await session("root");
    await session("child", "root");
    const teams = new TeamStore(env.DB);
    const source = await teams.create({
      slug: "source",
      name: "Source",
      joinPolicy: "invite_only",
    });
    const target = await teams.create({
      slug: "target",
      name: "Target",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = 'child'")
      .bind(source.id)
      .run();
    await new TeamMembershipStore(env.DB).add(target.id, OWNER);
    await grant(target.id);

    expect((await request("/sessions/root/scope", "PUT", { teamId: target.id })).status).toBe(200);
    const audits = await env.DB.prepare(
      "SELECT resource_id, metadata_json FROM authorization_audit_events WHERE action = 'session.moved' ORDER BY resource_id"
    ).all<{ resource_id: string; metadata_json: string }>();
    expect(
      audits.results.map((row) => ({
        sessionId: row.resource_id,
        before: JSON.parse(row.metadata_json).before.teamId,
      }))
    ).toEqual([
      { sessionId: "child", before: source.id },
      { sessionId: "root", before: null },
    ]);
  });

  it("does not audit a move when the requested scope is unchanged", async () => {
    await session("root");
    expect((await request("/sessions/root/scope", "PUT", { teamId: null })).status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'session.moved'"
    ).first<{ count: number }>();
    expect(audit?.count).toBe(0);
  });

  it("does not move a child without includeChildren and refuses a missing grant", async () => {
    await session("root");
    await session("child", "root");
    const team = await new TeamStore(env.DB).create({
      slug: "alpha",
      name: "Alpha",
      joinPolicy: "open",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    const denied = await request("/sessions/root/scope", "PUT", { teamId: team.id });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/web-app",
    });
    await grant(team.id);
    expect(
      (await request("/sessions/root/scope", "PUT", { teamId: team.id, includeChildren: false }))
        .status
    ).toBe(200);
    expect((await new SessionIndexStore(env.DB).get("child"))?.ownerTeamId).toBeNull();
  });

  it("requires grants for every repository of every descendant before joining a team", async () => {
    await session("root");
    await session("child", "root");
    await env.DB.prepare(
      `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
       VALUES ('child', 1, 'acme', 'api', 67890, 'main')`
    ).run();
    const team = await new TeamStore(env.DB).create({
      slug: "multi-repo",
      name: "Multi-repo",
      joinPolicy: "open",
    });
    await env.DB.prepare(
      `INSERT INTO team_repository_grants
       (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
       VALUES (?, ?, 'repository', 12345, 'acme', 'web-app', ?)`
    )
      .bind(crypto.randomUUID(), team.id, Date.now())
      .run();

    const denied = await request("/sessions/root/scope", "PUT", {
      teamId: team.id,
      joinTeam: true,
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/api",
    });
    expect((await new SessionIndexStore(env.DB).get("root"))?.ownerTeamId).toBeNull();
    expect((await new SessionIndexStore(env.DB).get("child"))?.ownerTeamId).toBeNull();
    expect((await new TeamMembershipStore(env.DB).listForUser(OWNER)).has(team.id)).toBe(false);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action IN ('team.member_joined', 'session.moved')"
    ).first<{ count: number }>();
    expect(audit?.count).toBe(0);

    await env.DB.prepare(
      `INSERT INTO team_repository_grants
       (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
       VALUES (?, ?, 'repository', 67890, 'acme', 'api', ?)`
    )
      .bind(crypto.randomUUID(), team.id, Date.now())
      .run();
    expect(
      (await request("/sessions/root/scope", "PUT", { teamId: team.id, joinTeam: true })).status
    ).toBe(200);
    expect((await new SessionIndexStore(env.DB).get("child"))?.ownerTeamId).toBe(team.id);
  });

  it("allows joining an open team on move but refuses archived teams", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "alpha",
      name: "Alpha",
      joinPolicy: "open",
    });
    await grant(team.id);
    expect(
      (await request("/sessions/root/scope", "PUT", { teamId: team.id, joinTeam: true })).status
    ).toBe(200);
    expect((await new TeamMembershipStore(env.DB).listForUser(OWNER)).get(team.id)).toBe("member");
    await new TeamStore(env.DB).archive(team.id);
    const denied = await request("/sessions/root/scope", "PUT", { teamId: team.id });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "team_archived" });
  });

  it("refuses a move when existing destination membership is removed after admission", async () => {
    await session("root");
    await session("child", "root");
    const team = await new TeamStore(env.DB).create({
      slug: "revoked",
      name: "Revoked",
      joinPolicy: "invite_only",
    });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(team.id, OWNER);
    await grant(team.id);
    const listForUser = TeamMembershipStore.prototype.listForUser;
    const read = vi
      .spyOn(TeamMembershipStore.prototype, "listForUser")
      .mockImplementation(async function (this: TeamMembershipStore, userId) {
        const roles = await listForUser.call(this, userId);
        if (userId === OWNER && roles.has(team.id)) {
          await memberships.remove(team.id, userId);
        }
        return roles;
      });
    try {
      const response = await request("/sessions/root/scope", "PUT", { teamId: team.id });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason_code: "not_member" });
      expect((await new SessionIndexStore(env.DB).get("root"))?.ownerTeamId).toBeNull();
      expect((await new SessionIndexStore(env.DB).get("child"))?.ownerTeamId).toBeNull();
      const audit = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'session.moved'"
      ).first<{ count: number }>();
      expect(audit?.count).toBe(0);
    } finally {
      read.mockRestore();
    }
  });

  it("rolls back an open-team join when the move audit fails", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "open-team",
      name: "Open",
      joinPolicy: "open",
    });
    const db = sqlDatabase(env.DB);
    const failAudit: SqlDatabase = {
      prepare(sql) {
        return sql.includes("INSERT INTO authorization_audit_events") && sql.includes("'session'")
          ? db.prepare("INSERT INTO authorization_audit_events (id) VALUES (?)").bind("bad-audit")
          : db.prepare(sql);
      },
      batch<T>(statements: SqlStatement[]) {
        return db.batch<T>(statements);
      },
    };
    const join = new TeamMembershipStore(failAudit).bindAddIfJoinable(team.id, OWNER);
    const teamAudit = new TeamAuditStore(failAudit).bind(
      {
        requestId: "test",
        actorUserId: OWNER,
        action: "team.member_joined",
        teamId: team.id,
        targetUserId: OWNER,
        before: {},
        after: { role: "member" },
      },
      true
    );
    const moveAudit = new SessionAuditStore(failAudit).bind({
      requestId: "test",
      actorUserId: OWNER,
      action: "session.moved",
      sessionId: "root",
      teamId: team.id,
      before: {},
      after: {},
    });
    await expect(
      new SessionScopeStore(failAudit).updateOwnerTeam(
        ["root"],
        team.id,
        [moveAudit],
        [join, teamAudit]
      )
    ).rejects.toThrow();
    expect((await new TeamMembershipStore(env.DB).listForUser(OWNER)).has(team.id)).toBe(false);
    expect((await new SessionIndexStore(env.DB).get("root"))?.ownerTeamId).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action IN ('team.member_joined', 'session.moved')"
        ).first<{ count: number }>()
      )?.count
    ).toBe(0);
  });

  it("does not move or audit when the target becomes archived before the join batch", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "closed-race",
      name: "Closed",
      joinPolicy: "open",
    });
    const memberships = new TeamMembershipStore(env.DB);
    const join = memberships.bindAddIfJoinable(team.id, OWNER);
    const joinedAudit = new TeamAuditStore(env.DB).bind(
      {
        requestId: "test",
        actorUserId: OWNER,
        action: "team.member_joined",
        teamId: team.id,
        targetUserId: OWNER,
        before: {},
        after: { role: "member" },
      },
      true
    );
    const moveAudit = new SessionAuditStore(env.DB).bind(
      {
        requestId: "test",
        actorUserId: OWNER,
        action: "session.moved",
        sessionId: "root",
        teamId: team.id,
        before: {},
        after: {},
      },
      true
    );
    await new TeamStore(env.DB).archive(team.id);
    expect(
      await new SessionScopeStore(env.DB).updateOwnerTeam(
        ["root"],
        team.id,
        [moveAudit],
        [join, joinedAudit],
        OWNER
      )
    ).toBe(false);
    expect((await memberships.listForUser(OWNER)).has(team.id)).toBe(false);
    expect((await new SessionIndexStore(env.DB).get("root"))?.ownerTeamId).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action IN ('team.member_joined', 'session.moved')"
        ).first<{ count: number }>()
      )?.count
    ).toBe(0);
  });

  it("does not audit an open-team join if membership already exists", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "already-joined",
      name: "Already joined",
      joinPolicy: "open",
    });
    const memberships = new TeamMembershipStore(env.DB);
    const join = memberships.bindAddIfJoinable(team.id, OWNER);
    const joinedAudit = new TeamAuditStore(env.DB).bind(
      {
        requestId: "test",
        actorUserId: OWNER,
        action: "team.member_joined",
        teamId: team.id,
        targetUserId: OWNER,
        before: {},
        after: { role: "member" },
      },
      true
    );
    await memberships.add(team.id, OWNER);
    expect(
      await new SessionScopeStore(env.DB).updateOwnerTeam(
        ["root"],
        team.id,
        [],
        [join, joinedAudit],
        OWNER
      )
    ).toBe(true);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'team.member_joined'"
        ).first<{ count: number }>()
      )?.count
    ).toBe(0);
  });

  it("converts team visibility to workspace when removing the owning team", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "alpha",
      name: "Alpha",
      joinPolicy: "open",
    });
    await grant(team.id);
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    expect((await request("/sessions/root/scope", "PUT", { teamId: team.id })).status).toBe(200);
    expect((await request("/sessions/root/visibility", "PUT", { visibility: "team" })).status).toBe(
      200
    );
    expect((await request("/sessions/root/scope", "PUT", { teamId: null })).status).toBe(200);
    expect(await new SessionIndexStore(env.DB).get("root")).toMatchObject({
      ownerTeamId: null,
      visibility: "workspace",
    });
  });

  it("audits only the descendant that changes on a partially unchanged move", async () => {
    await session("root");
    await session("child", "root");
    const team = await new TeamStore(env.DB).create({
      slug: "child-team",
      name: "Child team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare(
      "UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = 'child'"
    )
      .bind(team.id)
      .run();

    const moved = await request("/sessions/root/scope", "PUT", { teamId: null });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ affectedSessionIds: ["child"] });
    expect(await new SessionIndexStore(env.DB).get("child")).toMatchObject({
      ownerTeamId: null,
      visibility: "workspace",
    });
    const audits = await env.DB.prepare(
      "SELECT resource_id, metadata_json FROM authorization_audit_events WHERE action = 'session.moved'"
    ).all<{ resource_id: string; metadata_json: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0].resource_id).toBe("child");
    expect(JSON.parse(audits.results[0].metadata_json)).toEqual({
      before: { teamId: team.id, visibility: "team" },
      requested: {},
      after: { teamId: null, visibility: "workspace" },
    });
  });

  it("audits only changed rows in a visibility cascade and none on a repeat request", async () => {
    await session("root");
    await session("child", "root");
    await session("grandchild", "child");
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = 'child'").run();

    const changed = await request("/sessions/root/visibility", "PUT", { visibility: "private" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      affectedSessionIds: expect.arrayContaining(["root", "child", "grandchild"]),
    });
    for (const id of ["root", "child", "grandchild"]) {
      expect((await new SessionIndexStore(env.DB).get(id))?.visibility).toBe("private");
    }
    const audits = await env.DB.prepare(
      `SELECT request_id, actor_user_id_snapshot, resource_id, team_id, metadata_json
       FROM authorization_audit_events WHERE action = 'session.visibility_changed' ORDER BY resource_id`
    ).all<{
      request_id: string;
      actor_user_id_snapshot: string;
      resource_id: string;
      team_id: string | null;
      metadata_json: string;
    }>();
    expect(
      audits.results.map((row) => ({
        requestId: row.request_id,
        actor: row.actor_user_id_snapshot,
        sessionId: row.resource_id,
        teamId: row.team_id,
        metadata: JSON.parse(row.metadata_json),
      }))
    ).toEqual(
      ["grandchild", "root"].map((sessionId) => ({
        requestId: changed.headers.get("x-request-id"),
        actor: OWNER,
        sessionId,
        teamId: null,
        metadata: {
          before: { visibility: "workspace" },
          requested: {},
          after: { visibility: "private" },
        },
      }))
    );
    expect(
      (await request("/sessions/root/visibility", "PUT", { visibility: "private" })).status
    ).toBe(200);
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'session.visibility_changed'"
    ).first<{ count: number }>();
    expect(auditCount?.count).toBe(2);
  });

  it("refuses a readable but non-owned descendant without changing any visibility", async () => {
    await session("root");
    await session("child", "root", COLLABORATOR);
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.member.id, OWNER)
      .run();

    const response = await request("/sessions/root/visibility", "PUT", { visibility: "private" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason_code: "not_owner_or_lead" });
    expect((await new SessionIndexStore(env.DB).get("root"))?.visibility).toBe("workspace");
    expect((await new SessionIndexStore(env.DB).get("child"))?.visibility).toBe("workspace");
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'session.visibility_changed'"
    ).first<{ count: number }>();
    expect(audit?.count).toBe(0);
  });

  it("refuses private without an owner and lets a collaborator remove only themselves", async () => {
    await session("unowned", undefined, null);
    const denied = await request("/sessions/unowned/visibility", "PUT", { visibility: "private" });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "owner_required" });
    await initSession({ sessionName: "root", userId: OWNER });
    expect((await request(`/sessions/root/collaborators/${COLLABORATOR}`, "PUT")).status).toBe(200);
    expect(
      (await request("/sessions/root/visibility", "PUT", { visibility: "private" })).status
    ).toBe(200);
    const snapshot = await request("/sessions/root", "GET", undefined, COLLABORATOR);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      session: {
        ownerTeamId: null,
        visibility: "private",
        collaborators: [COLLABORATOR],
        capabilities: { canRead: true, canCollaborate: true, canManageCollaborators: false },
      },
    });
    expect(await (await request("/sessions", "GET", undefined, COLLABORATOR)).json()).toMatchObject(
      {
        sessions: expect.arrayContaining([
          expect.objectContaining({
            id: "root",
            visibility: "private",
            capabilities: expect.objectContaining({ canRead: true, canCollaborate: true }),
          }),
        ]),
      }
    );
    expect(
      (await request(`/sessions/root/collaborators/${OWNER}`, "DELETE", undefined, COLLABORATOR))
        .status
    ).toBe(403);
    expect(
      (
        await request(
          `/sessions/root/collaborators/${COLLABORATOR}`,
          "DELETE",
          undefined,
          COLLABORATOR
        )
      ).status
    ).toBe(200);
    expect((await request("/sessions/root", "GET", undefined, COLLABORATOR)).status).toBe(404);
  });

  it("reads and edits requireTeamOnCreate under workspace member management", async () => {
    expect(await (await request("/settings/teams")).json()).toEqual({ requireTeamOnCreate: false });
    expect((await request("/settings/teams", "PATCH", { requireTeamOnCreate: true })).status).toBe(
      200
    );
    expect(await (await request("/settings/teams")).json()).toEqual({ requireTeamOnCreate: true });
    const stored = await env.DB.prepare(
      "SELECT settings FROM integration_settings WHERE integration_id = 'teams'"
    ).first<{ settings: string }>();
    expect(JSON.parse(stored!.settings)).toEqual({ defaults: { requireTeamOnCreate: true } });
    expect(
      (await request("/settings/teams", "PATCH", { requireTeamOnCreate: false }, COLLABORATOR))
        .status
    ).toBe(403);
  });

  it("rejects creating without a required team and as a nonmember of a selected team", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "alpha",
      name: "Alpha",
      joinPolicy: "invite_only",
    });
    expect((await request("/settings/teams", "PATCH", { requireTeamOnCreate: true })).status).toBe(
      200
    );
    const missing = await request("/sessions", "POST", { title: "No team" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "team_required" });
    const nonmember = await request("/sessions", "POST", { title: "Wrong team", teamId: team.id });
    expect(nonmember.status).toBe(403);
    expect(await nonmember.json()).toMatchObject({ code: "not_member" });
  });

  it("creates team-default and explicitly private sessions with persisted scope and private audit", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "creator-team",
      name: "Creator team",
      joinPolicy: "invite_only",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    expect((await request("/settings/teams", "PATCH", { requireTeamOnCreate: true })).status).toBe(
      200
    );

    const defaultResponse = await request("/sessions", "POST", {
      title: "Team default",
      teamId: team.id,
    });
    expect(defaultResponse.status).toBe(201);
    const { sessionId: defaultId } = await defaultResponse.json<{ sessionId: string }>();
    expect(await new SessionIndexStore(env.DB).get(defaultId)).toMatchObject({
      ownerTeamId: team.id,
      visibility: "team",
      userId: OWNER,
    });
    const state = await env.SESSION.get(env.SESSION.idFromName(defaultId)).fetch(
      "http://internal/internal/state"
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ status: expect.any(String) });

    const privateResponse = await request("/sessions", "POST", {
      title: "Explicitly private",
      teamId: team.id,
      visibility: "private",
    });
    expect(privateResponse.status).toBe(201);
    const { sessionId: privateId } = await privateResponse.json<{ sessionId: string }>();
    expect(await new SessionIndexStore(env.DB).get(privateId)).toMatchObject({
      ownerTeamId: team.id,
      visibility: "private",
      userId: OWNER,
    });
    const audit = await env.DB.prepare(
      `SELECT request_id, actor_user_id_snapshot, resource_id, team_id, metadata_json
       FROM authorization_audit_events WHERE action = 'session.created_private'`
    ).first<{
      request_id: string;
      actor_user_id_snapshot: string;
      resource_id: string;
      team_id: string;
      metadata_json: string;
    }>();
    expect(audit).toMatchObject({
      request_id: privateResponse.headers.get("x-request-id"),
      actor_user_id_snapshot: OWNER,
      resource_id: privateId,
      team_id: team.id,
    });
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      before: {},
      requested: {},
      after: { ownerUserId: OWNER, teamId: team.id, visibility: "private" },
    });
  });

  it("keeps a child visible as its own root when its parent becomes private", async () => {
    await session("root");
    await session("child", "root");
    expect(
      (
        await request("/sessions/root/visibility", "PUT", {
          visibility: "private",
          includeChildren: false,
        })
      ).status
    ).toBe(200);
    const listed = await request("/sessions", "GET", undefined, COLLABORATOR);
    expect(
      (await listed.json<{ sessions: Array<{ id: string }> }>()).sessions.map((row) => row.id)
    ).toEqual(["child"]);
    const inbox = await request("/sessions/inbox", "GET", undefined, COLLABORATOR);
    expect(inbox.status).toBe(200);
    const body = await inbox.json<{
      categories: { finished: { items: Array<{ rootSession: { id: string } }> } };
    }>();
    expect(body.categories.finished.items.map((item) => item.rootSession.id)).toEqual(["child"]);
  });

  it("does not publish a private child during a parent visibility cascade", async () => {
    await session("root");
    await session("private-child", "root", COLLABORATOR);
    await env.DB.prepare(
      "UPDATE sessions SET visibility = 'private' WHERE id = 'private-child'"
    ).run();
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.member.id, OWNER)
      .run();

    const response = await request("/sessions/root/visibility", "PUT", { visibility: "workspace" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect((await new SessionIndexStore(env.DB).get("private-child"))?.visibility).toBe("private");
  });

  it("does not move a child from a team the parent owner cannot access", async () => {
    await session("root");
    await session("team-child", "root");
    const team = await new TeamStore(env.DB).create({
      slug: "other",
      name: "Other",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?")
      .bind(team.id, "team-child")
      .run();
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY.member.id, OWNER)
      .run();

    const response = await request("/sessions/root/scope", "PUT", { teamId: null });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(await new SessionIndexStore(env.DB).get("team-child")).toMatchObject({
      ownerTeamId: team.id,
      visibility: "team",
    });
  });

  it("removes an inactive collaborator without allowing them to be added again", async () => {
    await session("root");
    expect((await request(`/sessions/root/collaborators/${COLLABORATOR}`, "PUT")).status).toBe(200);
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), COLLABORATOR)
      .run();
    const removed = await request(`/sessions/root/collaborators/${COLLABORATOR}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("root")).toEqual([]);
    const add = await request(`/sessions/root/collaborators/${COLLABORATOR}`, "PUT");
    expect(add.status).toBe(409);
    expect(await add.json()).toMatchObject({ code: "user_inactive" });
  });

  it("enforces collaborator HTTP authorization and audits only effective changes", async () => {
    await session("root");
    const path = `/sessions/root/collaborators/${COLLABORATOR}`;
    const added = await request(path, "PUT");
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ status: "updated" });
    expect(await (await request(path, "PUT")).json()).toMatchObject({ status: "unchanged" });
    expect(
      (await request(`/sessions/root/collaborators/${OWNER}`, "PUT", undefined, COLLABORATOR))
        .status
    ).toBe(403);
    expect(
      (await request(`/sessions/root/collaborators/${OWNER}`, "DELETE", undefined, COLLABORATOR))
        .status
    ).toBe(403);
    const removed = await request(path, "DELETE", undefined, COLLABORATOR);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ status: "updated" });
    expect(await (await request(path, "DELETE", undefined, COLLABORATOR)).json()).toMatchObject({
      status: "unchanged",
    });
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("root")).toEqual([]);
    const audits = await env.DB.prepare(
      `SELECT action, request_id, actor_user_id_snapshot, target_user_id_snapshot, resource_id, metadata_json
       FROM authorization_audit_events WHERE action IN ('session.collaborator_added', 'session.collaborator_removed')
       ORDER BY action`
    ).all<{
      action: string;
      request_id: string;
      actor_user_id_snapshot: string;
      target_user_id_snapshot: string;
      resource_id: string;
      metadata_json: string;
    }>();
    expect(
      audits.results.map((row) => ({
        action: row.action,
        requestId: row.request_id,
        actor: row.actor_user_id_snapshot,
        target: row.target_user_id_snapshot,
        sessionId: row.resource_id,
        metadata: JSON.parse(row.metadata_json),
      }))
    ).toEqual([
      {
        action: "session.collaborator_added",
        requestId: added.headers.get("x-request-id"),
        actor: OWNER,
        target: COLLABORATOR,
        sessionId: "root",
        metadata: { before: { collaborator: false }, requested: {}, after: { collaborator: true } },
      },
      {
        action: "session.collaborator_removed",
        requestId: removed.headers.get("x-request-id"),
        actor: COLLABORATOR,
        target: COLLABORATOR,
        sessionId: "root",
        metadata: { before: { collaborator: true }, requested: {}, after: { collaborator: false } },
      },
    ]);
  });

  it("audits only collaborator writes that changed a row", async () => {
    await session("root");
    const store = new SessionCollaboratorStore(env.DB);
    const audit = (action: "session.collaborator_added" | "session.collaborator_removed") => ({
      requestId: crypto.randomUUID(),
      actorUserId: OWNER,
      action,
      sessionId: "root",
      teamId: null,
      targetUserId: COLLABORATOR,
      before: {},
      after: {},
    });
    expect(
      await Promise.all([
        store.add("root", COLLABORATOR, OWNER, audit("session.collaborator_added")),
        store.add("root", COLLABORATOR, OWNER, audit("session.collaborator_added")),
      ])
    ).toContain(false);
    expect(
      await Promise.all([
        store.remove("root", COLLABORATOR, audit("session.collaborator_removed")),
        store.remove("root", COLLABORATOR, audit("session.collaborator_removed")),
      ])
    ).toContain(false);
    const rows = await env.DB.prepare(
      "SELECT action FROM authorization_audit_events WHERE resource_id = 'root' ORDER BY action"
    ).all();
    expect(rows.results).toEqual([
      { action: "session.collaborator_added" },
      { action: "session.collaborator_removed" },
    ]);
  });

  it("reports effective legacy capabilities for a nonmember in shadow mode", async () => {
    await initSession({ sessionName: "team-session", userId: OWNER });
    const team = await new TeamStore(env.DB).create({
      slug: "other",
      name: "Other",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = ?")
      .bind(team.id, "team-session")
      .run();
    const snapshot = await request("/sessions/team-session", "GET", undefined, COLLABORATOR);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      session: {
        capabilities: {
          canRead: true,
          canCollaborate: true,
          canMove: false,
          canChangeVisibility: false,
        },
      },
    });
    expect(await (await request("/sessions", "GET", undefined, COLLABORATOR)).json()).toMatchObject(
      {
        sessions: [
          expect.objectContaining({
            capabilities: expect.objectContaining({ canRead: true, canMove: false }),
          }),
        ],
      }
    );
  });

  it("filters before pagination and agrees with snapshot capabilities across enforcement modes", async () => {
    await initSession({ sessionName: "team-session", userId: OWNER });
    await session("private-session", undefined, COLLABORATOR);
    await session("workspace-new");
    await session("workspace-old");
    const team = await new TeamStore(env.DB).create({
      slug: "pagination-team",
      name: "Pagination team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare(
      "UPDATE sessions SET owner_team_id = ?, visibility = 'team' WHERE id = 'team-session'"
    )
      .bind(team.id)
      .run();
    await env.DB.prepare(
      "UPDATE sessions SET visibility = 'private' WHERE id = 'private-session'"
    ).run();
    for (const [id, updatedAt] of [
      ["team-session", 400],
      ["private-session", 300],
      ["workspace-new", 200],
      ["workspace-old", 100],
    ] as const) {
      await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .bind(updatedAt, id)
        .run();
    }
    const as = { userId: COLLABORATOR, role: "member" } as const;
    async function fetchMode(path: string, mode: "on" | "shadow") {
      const url = `${BASE}${path}`;
      return routeRequest(
        new Request(url, { headers: await serviceRequestHeaders(url, { as }) }),
        { ...env, TEAMS_ENFORCEMENT: mode },
        createExecutionContext()
      );
    }

    for (const [mode, expectedIds] of [
      ["on", ["private-session", "workspace-new", "workspace-old"]],
      ["shadow", ["team-session", "private-session", "workspace-new", "workspace-old"]],
    ] as const) {
      for (const [offset, id] of expectedIds.entries()) {
        const response = await fetchMode(`/sessions?limit=1&offset=${offset}`, mode);
        expect(response.status).toBe(200);
        const page = await response.json<{
          sessions: Array<{ id: string; capabilities: Record<string, boolean> }>;
          hasMore: boolean;
        }>();
        expect(page.sessions.map((row) => row.id)).toEqual([id]);
        expect(page.sessions[0].capabilities.canRead).toBe(true);
        expect(page.hasMore).toBe(offset < expectedIds.length - 1);
        if (mode === "shadow" && id === "team-session") {
          const snapshot = await fetchMode(`/sessions/${id}`, mode);
          expect(snapshot.status).toBe(200);
          const snapshotBody = await snapshot.json<{
            session: { capabilities: Record<string, boolean> };
          }>();
          expect(snapshotBody.session.capabilities).toEqual(page.sessions[0].capabilities);
          expect(page.sessions[0].capabilities).toMatchObject({
            canRead: true,
            canCollaborate: true,
            canMove: false,
            canChangeVisibility: false,
          });
        }
      }
      const beyond = await fetchMode(`/sessions?limit=1&offset=${expectedIds.length}`, mode);
      expect(await beyond.json()).toMatchObject({ sessions: [], hasMore: false });
    }
    expect((await fetchMode("/sessions/team-session", "on")).status).toBe(404);
  });
});
