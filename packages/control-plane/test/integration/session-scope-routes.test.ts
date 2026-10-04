import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionScopeStore } from "../../src/db/session-scope-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  routeRequest,
  seedActiveUser,
  serviceFetch,
  serviceRequestHeaders,
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

describe("session scope routes", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(COLLABORATOR);
    await request("/me/authorization");
  });

  it("does not audit allowed collaborator-candidate reads but still audits denials", async () => {
    await session("root");
    const path = "/sessions/root/collaborator-candidates";
    const allowed = await request(path);
    expect(allowed.status).toBe(200);
    const denied = await request(path, "GET", undefined, COLLABORATOR);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "not_owner_or_lead" });
    for (const [response, expected] of [
      [allowed, []],
      [denied, [{ action: "authorization.request_denied" }]],
    ] as const) {
      const events = await env.DB.prepare(
        "SELECT action FROM authorization_audit_events WHERE request_id = ?"
      )
        .bind(response.headers.get("x-request-id"))
        .all();
      expect(events.results).toEqual(expected);
    }
  });

  it("returns 404 for the removed ownership scope endpoint", async () => {
    await session("root");
    const response = await request("/sessions/root/scope", "PUT", { teamId: null });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
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

  it("does not audit a descendant deleted after visibility preflight", async () => {
    await session("root");
    await session("child", "root");
    const original = SessionScopeStore.prototype.updateVisibility;
    const write = vi
      .spyOn(SessionScopeStore.prototype, "updateVisibility")
      .mockImplementation(async function (this: SessionScopeStore, ...args) {
        await env.DB.prepare("DELETE FROM sessions WHERE id = 'child'").run();
        return original.apply(this, args);
      });
    try {
      expect(
        (await request("/sessions/root/visibility", "PUT", { visibility: "private" })).status
      ).toBe(200);
      const audits = await env.DB.prepare(
        "SELECT resource_id FROM authorization_audit_events WHERE action = 'session.visibility_changed'"
      ).all<{ resource_id: string }>();
      expect(audits.results).toEqual([{ resource_id: "root" }]);
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    { initial: "private", current: "workspace", changed: true },
    { initial: "workspace", current: "private", changed: false },
    { initial: "team", current: "workspace", changed: true },
  ] as const)(
    "audits persisted visibility after a descendant changes from $initial to $current during admission",
    async ({ initial, current, changed }) => {
      await session("root");
      await session("child", "root");
      const team = await new TeamStore(env.DB).create({
        slug: "audit-race",
        name: "Audit race",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      await env.DB.prepare(
        "UPDATE sessions SET visibility = ?, owner_team_id = ? WHERE id = 'child'"
      )
        .bind(initial, team.id)
        .run();
      const original = SessionIndexStore.prototype.getByIds;
      const read = vi
        .spyOn(SessionIndexStore.prototype, "getByIds")
        .mockImplementationOnce(async function (this: SessionIndexStore, ...args) {
          const result = await original.apply(this, args);
          await env.DB.prepare("UPDATE sessions SET visibility = ? WHERE id = 'child'")
            .bind(current)
            .run();
          return result;
        });
      try {
        const response = await request("/sessions/root/visibility", "PUT", {
          visibility: "private",
        });
        expect(response.status).toBe(200);
        expect((await new SessionIndexStore(env.DB).get("child"))?.visibility).toBe("private");
        const audits = await env.DB.prepare(
          `SELECT team_id, metadata_json FROM authorization_audit_events
        WHERE request_id = ? AND resource_id = 'child' AND action = 'session.visibility_changed'`
        )
          .bind(response.headers.get("x-request-id"))
          .all<{ team_id: string | null; metadata_json: string }>();
        expect(
          audits.results.map((row) => ({
            teamId: row.team_id,
            metadata: JSON.parse(row.metadata_json),
          }))
        ).toEqual(
          changed
            ? [
                {
                  teamId: team.id,
                  metadata: {
                    before: { visibility: current },
                    requested: {},
                    after: { visibility: "private" },
                  },
                },
              ]
            : []
        );
      } finally {
        read.mockRestore();
      }
    }
  );

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

  it("reports read-only team capabilities for a nonmember in shadow mode", async () => {
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
          canCollaborate: false,
          canChangeVisibility: false,
        },
      },
    });
    expect(await (await request("/sessions", "GET", undefined, COLLABORATOR)).json()).toMatchObject(
      {
        sessions: [
          expect.objectContaining({
            capabilities: expect.objectContaining({ canRead: true }),
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
            canCollaborate: false,
            canChangeVisibility: false,
          });
        }
      }
      const beyond = await fetchMode(`/sessions?limit=1&offset=${expectedIds.length}`, mode);
      expect(await beyond.json()).toMatchObject({ sessions: [], hasMore: false });
    }
    expect((await fetchMode("/sessions/team-session", "on")).status).toBe(404);
  });

  it("limits team-owned collaborators and candidates to members of the owning team", async () => {
    await session("root");
    const team = await new TeamStore(env.DB).create({
      slug: "owning",
      name: "Owning",
      joinPolicy: "invite_only",
    });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(team.id, OWNER);
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = 'root'")
      .bind(team.id)
      .run();
    const candidateIds = async () =>
      (await (await request("/sessions/root/collaborator-candidates")).json<{ userId: string }[]>())
        .map((candidate) => candidate.userId)
        .sort();
    const path = `/sessions/root/collaborators/${COLLABORATOR}`;

    expect(await candidateIds()).toEqual([OWNER]);
    const rejected = await request(path, "PUT");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "not_team_member" });
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("root")).toEqual([]);

    await memberships.add(team.id, COLLABORATOR);
    expect(await candidateIds()).toEqual([OWNER, COLLABORATOR].sort());
    const added = await request(path, "PUT");
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ status: "updated" });
    expect(
      (await request("/sessions/root/visibility", "PUT", { visibility: "private" })).status
    ).toBe(200);
    const listedIds = async () =>
      (
        await (
          await request("/sessions", "GET", undefined, COLLABORATOR)
        ).json<{
          sessions: { id: string }[];
        }>()
      ).sessions.map((listed) => listed.id);
    expect((await request("/sessions/root", "GET", undefined, COLLABORATOR)).status).toBe(200);
    expect(await listedIds()).toContain("root");

    // The grant lapses with membership even though the collaborator row remains.
    await memberships.remove(team.id, COLLABORATOR);
    expect(await new SessionCollaboratorStore(env.DB).listUserIds("root")).toEqual([COLLABORATOR]);
    expect((await request("/sessions/root", "GET", undefined, COLLABORATOR)).status).toBe(404);
    expect(await listedIds()).not.toContain("root");
  });
});
