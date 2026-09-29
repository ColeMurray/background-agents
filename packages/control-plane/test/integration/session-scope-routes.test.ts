import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser, serviceFetch } from "./helpers";

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
});
