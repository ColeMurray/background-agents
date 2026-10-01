import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
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
  mode: string,
  options: {
    method?: string;
    as?: { userId: string; role: "owner" | "administrator" | "member" | "viewer" };
    body?: string;
    service?: "linear-bot";
  } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  return routeRequest(
    new Request(url, {
      method,
      headers: await serviceRequestHeaders(url, {
        method,
        body: options.body,
        as: options.as,
        service: options.service,
      }),
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

  async function session(visibility: "team" | "private" | "workspace") {
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
    return { sessionName, team, stub };
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

  it("audits shadow read observations and enforced team action denials with the real status", async () => {
    const { sessionName } = await session("team");
    for (const [path, method, body] of [
      [`/sessions/${sessionName}`, "GET", undefined],
      [`/sessions/${sessionName}/budget`, "PATCH", JSON.stringify({ maxCostUsd: 20 })],
    ] as const) {
      const response = await fetchMode(path, "shadow", {
        method,
        body,
        as: { userId: MEMBER, role: "member" },
      });
      const rows = (
        await env.DB.prepare(
          "SELECT action, reason_code, metadata_json FROM authorization_audit_events WHERE request_id = ?"
        )
          .bind(response.headers.get("x-request-id"))
          .all()
      ).results;
      expect(response.status).toBe(method === "GET" ? 200 : 403);
      expect(rows).toHaveLength(1);
      const reason = method === "GET" ? "shadow_denied:not_member" : "not_member";
      expect(rows[0].reason_code).toBe(reason);
      expect(rows[0].action).toBe(
        method === "GET" ? "authorization.request_allowed" : "authorization.request_denied"
      );
      expect(JSON.parse(String(rows[0].metadata_json))).toMatchObject({
        httpStatus: response.status,
        responseCode: reason,
      });
    }
  });

  it("enforces team deletion ownership in shadow and off", async () => {
    const as = { userId: MEMBER, role: "member" } as const;
    const shadow = await session("team");
    await new TeamMembershipStore(env.DB).add(shadow.team.id, MEMBER);
    expect(
      (await fetchMode(`/sessions/${shadow.sessionName}`, "shadow", { method: "DELETE", as }))
        .status
    ).toBe(403);
    expect(
      (await auditRows("authorization.request_denied")).filter(
        (row) => row.reason_code === "not_owner_or_lead"
      )
    ).toHaveLength(1);
    const off = await session("team");
    expect(
      (await fetchMode(`/sessions/${off.sessionName}`, "off", { method: "DELETE", as })).status
    ).toBe(403);
  });

  it.each(["off", "shadow", "on"] as const)(
    "requires current membership for workspace-visible team interaction in %s mode",
    async (mode) => {
      const { sessionName, team, stub } = await session("workspace");
      await queryDO(
        stub,
        "UPDATE sandbox SET status = 'ready', code_server_url = ?, vnc_url = ?, ttyd_url = ?, tunnel_urls = ?, modal_object_id = ?",
        "https://code.example.test",
        "https://vnc.example.test",
        "https://terminal.example.test",
        JSON.stringify({ "3000": "https://app.example.test" }),
        "team-access-sandbox"
      );
      for (const as of [
        { userId: MEMBER, role: "member" },
        { userId: CREATOR, role: "member" },
        { userId: OWNER, role: "owner" },
        { userId: "44444444444444444444444444444444", role: "administrator" },
      ] as const) {
        for (const [path, method] of [
          ["prompt", "POST"],
          ["sandbox-access", "GET"],
        ] as const) {
          const response = await fetchMode(`/sessions/${sessionName}/${path}`, mode, {
            as,
            method,
            body: method === "POST" ? JSON.stringify({ content: "Denied" }) : undefined,
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            error: "Forbidden",
            code: "session_action_denied",
            reason_code: "not_member",
          });
        }
        const snapshot = await fetchMode(`/sessions/${sessionName}`, mode, { as });
        expect(snapshot.status).toBe(200);
        const body = await snapshot.json();
        expect(body).toMatchObject({
          session: {
            capabilities: {
              canRead: true,
              canCollaborate: false,
              canManageLifecycle: false,
              canDelete: false,
              canSandbox: false,
              canManageCollaborators: false,
              canChangeVisibility: false,
            },
          },
        });
        for (const field of [
          "codeServerUrl",
          "sandboxDashboardUrl",
          "vncUrl",
          "ttydUrl",
          "tunnelUrls",
        ]) {
          expect(body).not.toHaveProperty(`session.${field}`);
        }
      }
      await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
      const as = { userId: MEMBER, role: "member" } as const;
      expect(
        (await fetchMode(`/sessions/${sessionName}/sandbox-access`, mode, { as })).status
      ).toBe(200);
      const prompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as,
        method: "POST",
        body: JSON.stringify({ content: "Allowed" }),
      });
      expect(prompt.status).toBe(200);
      expect(
        await (await fetchMode(`/sessions/${sessionName}`, mode, { as })).json()
      ).toMatchObject({
        session: {
          capabilities: { canCollaborate: true, canManageLifecycle: true, canSandbox: true },
        },
      });
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "refuses a removed owner's private team prompt and permits collaborator self-removal in %s mode",
    async (mode) => {
      const { sessionName, team } = await session("private");
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, CREATOR);
      await memberships.remove(team.id, CREATOR);
      const prompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as: { userId: CREATOR, role: "member" },
        method: "POST",
        body: JSON.stringify({ content: "Denied" }),
      });
      expect(prompt.status).toBe(403);
      expect(await prompt.json()).toMatchObject({ reason_code: "not_member" });
      const collaborators = new SessionCollaboratorStore(env.DB);
      await collaborators.add(sessionName, MEMBER, CREATOR);
      const as = { userId: MEMBER, role: "member" } as const;
      const collaboratorPrompt = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        as,
        method: "POST",
        body: JSON.stringify({ content: "Denied" }),
      });
      expect(collaboratorPrompt.status).toBe(403);
      expect(await collaboratorPrompt.json()).toMatchObject({ reason_code: "not_member" });
      const removed = await fetchMode(`/sessions/${sessionName}/collaborators/${MEMBER}`, mode, {
        as,
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      expect(await collaborators.listUserIds(sessionName)).toEqual([]);
    }
  );

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

  it.each(["off", "shadow", "on"] as const)(
    "refuses an Owner break-glass prompt on a private session in %s mode",
    async (mode) => {
      const { sessionName } = await session("private");
      const response = await fetchMode(`/sessions/${sessionName}/prompt`, mode, {
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Forbidden",
        code: "session_action_denied",
        reason_code: "not_member",
      });
    }
  );

  it("loads memberships for snapshot capabilities even in off mode", async () => {
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
      expect(list).toHaveBeenCalledOnce();
    } finally {
      list.mockRestore();
    }
  });

  it("loads collaborators and memberships for an off-mode private team session", async () => {
    const { sessionName } = await session("private");
    const members = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
    const collaborators = vi.spyOn(SessionCollaboratorStore.prototype, "listUserIds");
    try {
      expect((await fetchMode(`/sessions/${sessionName}`, "off")).status).toBe(200);
      expect(members).toHaveBeenCalledOnce();
      expect(collaborators).toHaveBeenCalledOnce();
    } finally {
      members.mockRestore();
      collaborators.mockRestore();
    }
  });

  it("admits actorless Linear stop on non-private sessions in every mode, but hides private sessions", async () => {
    const team = await session("team");
    const privateSession = await session("private");
    const workspace = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(workspace.stub, "failed");
    for (const mode of ["off", "shadow", "on"] as const) {
      for (const id of [team.sessionName, workspace.sessionName]) {
        const response = await fetchMode(`/sessions/${id}/stop`, mode, {
          method: "POST",
          service: "linear-bot",
        });
        expect(response.status).toBe(200);
      }
      expect(
        (
          await fetchMode(`/sessions/${privateSession.sessionName}/stop`, mode, {
            method: "POST",
            service: "linear-bot",
          })
        ).status
      ).toBe(404);
    }
    expect(
      (await auditRows("authorization.request_allowed")).filter(
        (row) => row.reason_code === "shadow_denied:missing_permission"
      )
    ).toEqual([]);
  });

  it("conceals an invisible child even when its parent is visible", async () => {
    const parent = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(parent.stub, "failed");
    const child = await session("team");
    await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .bind(parent.sessionName, child.sessionName)
      .run();
    const as = { userId: MEMBER, role: "member" } as const;
    expect(
      (
        await fetchMode(`/sessions/${parent.sessionName}/children/${child.sessionName}`, "on", {
          as,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await fetchMode(
          `/sessions/${parent.sessionName}/children/${child.sessionName}/cancel`,
          "on",
          { as, method: "POST" }
        )
      ).status
    ).toBe(404);
    expect(
      (await auditRows("authorization.request_denied")).filter(
        (row) => row.reason_code === "session_not_visible"
      )
    ).toMatchObject([{ team_id: child.team.id }, { team_id: child.team.id }]);
  });

  it("lists only children visible in the selected enforcement mode", async () => {
    const parent = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(parent.stub, "failed");
    const workspace = await initSession({ userId: CREATOR });
    await waitForSandboxStatus(workspace.stub, "failed");
    const team = await session("team");
    const hidden = await session("private");
    for (const childId of [workspace.sessionName, team.sessionName, hidden.sessionName]) {
      await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
        .bind(parent.sessionName, childId)
        .run();
    }

    for (const mode of ["off", "shadow", "on"] as const) {
      const response = await fetchMode(`/sessions/${parent.sessionName}/children`, mode, {
        as: { userId: MEMBER, role: "member" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { children: { id: string }[] };
      expect(body.children.map((child) => child.id).sort()).toEqual(
        (mode === "on" ? [workspace.sessionName] : [workspace.sessionName, team.sessionName]).sort()
      );
    }
  });

  it("audits both private reads when an Owner accesses a private child", async () => {
    const parent = await session("private");
    const child = await session("private");
    await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .bind(parent.sessionName, child.sessionName)
      .run();
    await fetchMode(`/sessions/${parent.sessionName}/children/${child.sessionName}`, "on");
    expect(
      (await auditRows("session.private_break_glass")).map((row) => row.resource_id).sort()
    ).toEqual([parent.sessionName, child.sessionName].sort());
  });

  it("audits a permitted private read before a later handler denial", async () => {
    const { sessionName } = await session("private");
    const response = await fetchMode(`/sessions/${sessionName}/budget`, "off", {
      method: "PATCH",
      body: JSON.stringify({ maxCostUsd: 20 }),
    });
    expect(response.status).toBe(403);
    expect((await auditRows("session.private_break_glass")).map((row) => row.resource_id)).toEqual([
      sessionName,
    ]);
  });

  it("responds 503 to an invalid mode for both item and batch routes", async () => {
    expect((await fetchMode("/sessions/missing", "invalid")).status).toBe(503);
    expect(
      (
        await fetchMode("/sessions/batch-archive", "invalid", {
          method: "POST",
          body: JSON.stringify({ sessionIds: ["missing"] }),
        })
      ).status
    ).toBe(503);
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

  it.each(["off", "shadow", "on"] as const)(
    "refuses bulk-only custom-role team archiving without lifecycle permission in %s mode",
    async (mode) => {
      const { sessionName, team } = await session("team");
      await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO roles (id, key, name, normalized_name, is_system)
           VALUES ('role_bulk_only', NULL, 'Bulk Only', 'bulk only', 0)`
        ),
        env.DB.prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ('role_bulk_only', 'sessions.bulk_archive'),
                  ('role_bulk_only', 'sessions.read')`
        ),
        env.DB.prepare(
          "UPDATE user_role_assignments SET role_id = 'role_bulk_only' WHERE user_id = ?"
        ).bind(MEMBER),
      ]);

      const response = await fetchMode("/sessions/batch-archive", mode, {
        method: "POST",
        as: { userId: MEMBER, role: "member" },
        body: JSON.stringify({ sessionIds: [sessionName] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        results: [],
        skipped: [{ sessionId: sessionName, reason: "missing_permission" }],
      });
    }
  );

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
