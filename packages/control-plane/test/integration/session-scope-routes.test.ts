import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { TeamAuditStore } from "../../src/db/team-audit";
import { SessionAuditStore } from "../../src/db/session-audit";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";

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
      "SELECT action, team_id FROM authorization_audit_events WHERE action = 'session.moved'"
    ).all();
    expect(audit.results).toEqual([{ action: "session.moved", team_id: team.id }]);
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
      new SessionIndexStore(failAudit).updateOwnerTeam(
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
      await new SessionIndexStore(env.DB).updateOwnerTeam(
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
      await new SessionIndexStore(env.DB).updateOwnerTeam(
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
});
