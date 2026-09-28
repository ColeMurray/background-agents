import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  routeRequest,
  seedActiveUser,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const CREATOR = "33333333333333333333333333333333";

async function fetchMode(
  path: string,
  mode: "off" | "shadow" | "on",
  options: {
    method?: string;
    as?: { userId: string; role: "owner" | "member" | "viewer" };
    body?: string;
  } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  return routeRequest(
    new Request(url, {
      method,
      headers: await serviceRequestHeaders(url, { method, body: options.body, as: options.as }),
      body: options.body,
    }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

async function auditRows(action: string) {
  return (
    await env.DB.prepare(
      "SELECT action, resource_type, resource_id, team_id, reason_code, actor_user_id_snapshot FROM authorization_audit_events WHERE action = ? ORDER BY occurred_at"
    )
      .bind(action)
      .all()
  ).results;
}

describe("HTTP session access by enforcement mode", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    expect((await fetchMode("/me/authorization", "on")).status).toBe(200);
    expect(
      (
        await fetchMode("/me/authorization", "on", {
          as: { userId: MEMBER, role: "member" },
        })
      ).status
    ).toBe(200);
    await seedActiveUser(CREATOR);
  });

  async function session(visibility: "team" | "private") {
    const team = await new TeamStore(env.DB).create({
      slug: `access-${crypto.randomUUID()}`,
      name: "Access Team",
      joinPolicy: "invite_only",
    });
    const { sessionName, stub } = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(stub, "failed");
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = ? WHERE id = ?")
      .bind(team.id, visibility, sessionName)
      .run();
    return { sessionName, team };
  }

  it("conceals a team session on read and token mint when enforcement is on", async () => {
    const { sessionName, team } = await session("team");
    const as = { userId: MEMBER, role: "member" } as const;
    const snapshot = await fetchMode(`/sessions/${sessionName}`, "on", { as });
    const token = await fetchMode(`/sessions/${sessionName}/ws-token`, "on", {
      as,
      method: "POST",
    });
    expect(snapshot.status).toBe(404);
    expect(await snapshot.json()).toEqual({ error: "Session not found" });
    expect(token.status).toBe(404);
    const denied = await auditRows("authorization.request_denied");
    expect(denied.filter((row) => row.reason_code === "session_not_visible")).toHaveLength(2);
    expect(denied.find((row) => row.reason_code === "session_not_visible")?.team_id).toBe(team.id);
  });

  it("defers the team and delete rules in shadow but records each would-be denial", async () => {
    const { sessionName, team } = await session("team");
    const as = { userId: MEMBER, role: "member" } as const;
    const snapshot = await fetchMode(`/sessions/${sessionName}`, "shadow", { as });
    expect(snapshot.status).toBe(200);
    const shadowRows = (await auditRows("authorization.request_allowed")).filter(
      (row) => typeof row.reason_code === "string" && row.reason_code.startsWith("shadow_denied:")
    );
    expect(shadowRows).toMatchObject([
      { reason_code: "shadow_denied:not_member", team_id: team.id },
    ]);

    await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
    const denied = await fetchMode(`/sessions/${sessionName}`, "on", { as });
    expect(denied.status).toBe(200);
    const deletion = await fetchMode(`/sessions/${sessionName}`, "on", { as, method: "DELETE" });
    expect(deletion.status).toBe(403);
    expect(await deletion.json()).toEqual({
      error: "Forbidden",
      code: "session_action_denied",
      reason_code: "not_owner_or_lead",
    });
    await new TeamMembershipStore(env.DB).setRole(team.id, MEMBER, "lead");
    expect(
      (await fetchMode(`/sessions/${sessionName}`, "on", { as, method: "DELETE" })).status
    ).toBe(200);
  });

  it("allows legacy deletion in shadow and off while shadow audits the ownership denial", async () => {
    const as = { userId: MEMBER, role: "member" } as const;
    const shadow = await session("team");
    await new TeamMembershipStore(env.DB).add(shadow.team.id, MEMBER);
    expect(
      (await fetchMode(`/sessions/${shadow.sessionName}`, "shadow", { method: "DELETE", as }))
        .status
    ).toBe(200);
    expect(
      (await auditRows("authorization.request_allowed")).filter(
        (row) => row.reason_code === "shadow_denied:not_owner_or_lead"
      )
    ).toHaveLength(1);
    const off = await session("team");
    expect(
      (await fetchMode(`/sessions/${off.sessionName}`, "off", { method: "DELETE", as })).status
    ).toBe(200);
  });

  it("conceals another team's export even when the viewer holds sessions.export", async () => {
    const { sessionName } = await session("team");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_export_reader', NULL, 'Export Reader', 'export reader', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_export_reader', 'sessions.read'),
                ('role_export_reader', 'sessions.export')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_export_reader' WHERE user_id = ?"
      ).bind(MEMBER),
    ]);
    const response = await fetchMode(`/sessions/${sessionName}/export`, "on", {
      as: { userId: MEMBER, role: "member" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("keeps private sessions concealed in all modes and audits Owner break-glass once per read", async () => {
    const { sessionName, team } = await session("private");
    const as = { userId: MEMBER, role: "member" } as const;
    await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
    for (const mode of ["off", "shadow", "on"] as const) {
      expect((await fetchMode(`/sessions/${sessionName}`, mode, { as })).status).toBe(404);
    }
    expect((await fetchMode(`/sessions/${sessionName}`, "on")).status).toBe(200);
    expect(await auditRows("session.private_break_glass")).toMatchObject([
      {
        resource_type: "session",
        resource_id: sessionName,
        team_id: team.id,
        actor_user_id_snapshot: OWNER,
      },
    ]);
    await new SessionCollaboratorStore(env.DB).add(sessionName, MEMBER, OWNER);
    expect((await fetchMode(`/sessions/${sessionName}`, "on", { as })).status).toBe(200);
    expect(await auditRows("session.private_break_glass")).toHaveLength(1);
  });

  it("does not query memberships in off mode", async () => {
    const { sessionName } = await session("team");
    const list = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    try {
      expect(
        (
          await fetchMode(`/sessions/${sessionName}`, "off", {
            as: { userId: MEMBER, role: "member" },
          })
        ).status
      ).toBe(200);
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
  });

  it("skips hidden and action-denied batch targets independently", async () => {
    const hidden = await session("private");
    const visible = await session("team");
    await new TeamMembershipStore(env.DB).add(visible.team.id, MEMBER);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, is_system)
         VALUES ('role_batch_viewer', NULL, 'Batch Viewer', 'batch viewer', 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_batch_viewer', 'sessions.bulk_archive'),
                ('role_batch_viewer', 'sessions.read')`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_batch_viewer' WHERE user_id = ?"
      ).bind(MEMBER),
    ]);
    const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    const response = await fetchMode("/sessions/batch-archive", "on", {
      method: "POST",
      as: { userId: MEMBER, role: "member" },
      body: JSON.stringify({ sessionIds: [hidden.sessionName, visible.sessionName] }),
    });
    expect(memberships).toHaveBeenCalledOnce();
    memberships.mockRestore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [],
      skipped: [
        { sessionId: hidden.sessionName, reason: "not_found" },
        { sessionId: visible.sessionName, reason: "missing_permission" },
      ],
    });
  });

  it("lists, idempotently adds, and removes collaborators", async () => {
    const { sessionName } = await session("private");
    const store = new SessionCollaboratorStore(env.DB);
    expect(await store.add(sessionName, MEMBER, OWNER)).toBe(true);
    expect(await store.add(sessionName, MEMBER, OWNER)).toBe(false);
    expect(await store.listUserIds(sessionName)).toEqual([MEMBER]);
    expect(await store.listForUser(MEMBER)).toEqual([sessionName]);
    expect(await store.remove(sessionName, MEMBER)).toBe(true);
    expect(await store.remove(sessionName, MEMBER)).toBe(false);
    expect(await store.listUserIds(sessionName)).toEqual([]);
  });
});
