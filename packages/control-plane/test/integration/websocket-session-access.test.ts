import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { cleanD1Tables } from "./cleanup";
import { setSessionTeamsEnforcementMode } from "./session-do-access";
import {
  collectMessages,
  initNamedSession,
  issueClientWsToken,
  openClientWs,
  queryDO,
  routeRequest,
  seedMessage,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

describe("session WebSocket D1 access", () => {
  beforeEach(cleanD1Tables);

  async function scopedSession(visibility: "team" | "private", mode?: string) {
    const name = `ws-access-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(
      name,
      undefined,
      mode ? (sessionStub) => setSessionTeamsEnforcementMode(sessionStub, mode) : undefined
    );
    await waitForSandboxStatus(stub, "failed");
    const team = await new TeamStore(env.DB).create({
      slug: `ws-${crypto.randomUUID()}`,
      name: "Socket team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ?, visibility = ? WHERE id = ?")
      .bind(team.id, visibility, name)
      .run();
    return { name, stub, team };
  }

  it("rejects a still-valid token after private access is removed and refuses re-mint", async () => {
    const { name } = await scopedSession("private");
    const userId = crypto.randomUUID().replaceAll("-", "");
    const url = `https://test.local/sessions/${name}/ws-token`;
    const headers = await serviceRequestHeaders(url, {
      method: "POST",
      as: { userId, role: "member" },
    });
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add(name, userId, "user-1");

    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "collaborator" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
    await collaborators.remove(name, userId);

    const closedActive = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "fetch_history", cursor: { timestamp: 0, id: "event" } }));
    await expect(closedActive).resolves.toBe(4010);

    const { ws: stale } = await openClientWs(name);
    const closed = new Promise<number>((resolve) =>
      stale.addEventListener("close", (event) => resolve(event.code))
    );
    stale.send(JSON.stringify({ type: "subscribe", token, clientId: "stale" }));
    await expect(closed).resolves.toBe(4010);

    const response = await routeRequest(
      new Request(url, {
        method: "POST",
        headers,
      }),
      { ...env, TEAMS_ENFORCEMENT: "on" },
      createExecutionContext()
    );
    expect(response.status).toBe(404);
  });

  it("samples team permissions in shadow and rechecks the private row on the next command", async () => {
    const { name, team } = await scopedSession("team");
    const userId = `team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    await new TeamMembershipStore(env.DB).add(team.id, userId);
    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "member" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);

    await new TeamMembershipStore(env.DB).remove(team.id, userId);
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(name)
      .run();
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "presence", status: "idle" }));
    await expect(closed).resolves.toBe(4010);
  });

  it("denies a member of another team at subscribe with enforcement on", async () => {
    const { name } = await scopedSession("team", "on");
    const otherTeam = await new TeamStore(env.DB).create({
      slug: `other-${crypto.randomUUID()}`,
      name: "Other team",
      joinPolicy: "invite_only",
    });
    const userId = `other-team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    await new TeamMembershipStore(env.DB).add(otherTeam.id, userId);

    const { ws } = await openClientWs(name);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "other-team" }));

    await expect(closed).resolves.toBe(4010);
  });

  it.each(["off", "shadow", "on"] as const)(
    "loads memberships at subscribe but skips unused scope reads on commands in %s mode",
    async (mode) => {
      const { name, team } = await scopedSession("team", mode);
      const userId = `query-member-${crypto.randomUUID()}`;
      const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
      await new TeamMembershipStore(env.DB).add(team.id, userId);
      const { ws } = await openClientWs(name);
      const memberships = vi.spyOn(TeamMembershipStore.prototype, "listForUser");
      const collaborators = vi.spyOn(SessionCollaboratorStore.prototype, "listUserIds");
      try {
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "scope-reads" }));
        expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
        expect(memberships).toHaveBeenCalledTimes(1);
        expect(collaborators).toHaveBeenCalledTimes(mode === "on" ? 1 : 0);
        memberships.mockClear();
        collaborators.mockClear();

        const history = collectMessages(ws, {
          until: (message) => message.type === "history_page",
        });
        ws.send(JSON.stringify({ type: "fetch_history", cursor: { timestamp: 0, id: "event" } }));
        expect((await history).some((message) => message.type === "history_page")).toBe(true);
        expect(memberships).toHaveBeenCalledTimes(mode === "on" ? 1 : 0);
        expect(collaborators).toHaveBeenCalledTimes(mode === "on" ? 1 : 0);
      } finally {
        memberships.mockRestore();
        collaborators.mockRestore();
        ws.close();
      }
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "sends move and visibility capabilities for a non-owner team lead in %s mode",
    async (mode) => {
      const { name, team } = await scopedSession("team", mode);
      const userId = `team-lead-${crypto.randomUUID()}`;
      const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
      await new TeamMembershipStore(env.DB).add(team.id, userId, "lead");
      const { ws } = await openClientWs(name);
      try {
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "lead" }));
        expect((await subscribed).find((message) => message.type === "subscribed")).toMatchObject({
          session: {
            capabilities: {
              canMove: true,
              canChangeVisibility: true,
              canManageCollaborators: false,
            },
          },
        });
      } finally {
        ws.close();
      }
    }
  );

  it("closes on the next prompt after membership removal and refuses the still-valid token", async () => {
    const { name, team } = await scopedSession("team", "on");
    const userId = crypto.randomUUID().replaceAll("-", "");
    const url = `https://test.local/sessions/${name}/ws-token`;
    const headers = await serviceRequestHeaders(url, {
      method: "POST",
      as: { userId, role: "member" },
    });
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(team.id, userId);

    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "member" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);

    await memberships.remove(team.id, userId);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "prompt", content: "not allowed", clientRequestId: "removed" }));
    await expect(closed).resolves.toBe(4010);

    const { ws: stale } = await openClientWs(name);
    const staleClosed = new Promise<number>((resolve) =>
      stale.addEventListener("close", (event) => resolve(event.code))
    );
    stale.send(JSON.stringify({ type: "subscribe", token, clientId: "stale" }));
    await expect(staleClosed).resolves.toBe(4010);
    const remint = await routeRequest(
      new Request(url, { method: "POST", headers }),
      { ...env, TEAMS_ENFORCEMENT: "on" },
      createExecutionContext()
    );
    expect(remint.status).toBe(404);
  });

  it("closes on the next command after a team move with enforcement on", async () => {
    const { name, team } = await scopedSession("team", "on");
    const userId = `moved-team-member-${crypto.randomUUID()}`;
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    await new TeamMembershipStore(env.DB).add(team.id, userId);
    const { ws } = await openClientWs(name);
    const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "member" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);

    const newTeam = await new TeamStore(env.DB).create({
      slug: `moved-${crypto.randomUUID()}`,
      name: "Destination team",
      joinPolicy: "invite_only",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(newTeam.id, name)
      .run();
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "presence", status: "idle" }));
    await expect(closed).resolves.toBe(4010);
  });

  it("audits each Owner break-glass subscribe but not the session owner or a collaborator", async () => {
    const { name, stub, team } = await scopedSession("private", "on");
    await env.DB.prepare("UPDATE sessions SET visibility = 'workspace' WHERE id = ?")
      .bind(name)
      .run();
    const ownerId = crypto.randomUUID().replaceAll("-", "");
    const { token } = await issueClientWsToken(name, { userId: ownerId, canonicalUserId: ownerId });
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
    )
      .bind(ownerId)
      .run();
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(name)
      .run();

    const sockets: WebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const { ws } = await openClientWs(name);
      sockets.push(ws);
      const subscribed = collectMessages(ws, { until: (message) => message.type === "subscribed" });
      ws.send(JSON.stringify({ type: "subscribe", token, clientId: `break-glass-${i}` }));
      expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
    }
    const audit = await env.DB.prepare(
      "SELECT principal_kind, actor_user_id_snapshot, resource_id, team_id, reason_code, metadata_json FROM authorization_audit_events WHERE action = 'session.private_break_glass' ORDER BY occurred_at, id"
    ).all();
    expect(audit.results).toHaveLength(2);
    for (const row of audit.results) {
      expect(row).toMatchObject({
        principal_kind: "user",
        actor_user_id_snapshot: ownerId,
        resource_id: name,
        team_id: team.id,
        reason_code: "session.private_break_glass",
      });
      expect(JSON.parse(String(row.metadata_json))).toEqual({
        before: {},
        requested: {},
        after: {},
      });
    }

    const ws = sockets[1];
    const denied = collectMessages(ws, {
      until: (message) =>
        message.type === "error" && message.message === "Access denied: not_collaborator",
    });
    ws.send(JSON.stringify({ type: "prompt", content: "not allowed", clientRequestId: "private" }));
    expect((await denied).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
      message: "Access denied: not_collaborator",
    });
    const deniedTyping = collectMessages(ws, { until: (message) => message.type === "error" });
    ws.send(JSON.stringify({ type: "typing" }));
    expect((await deniedTyping).find((message) => message.type === "error")).toMatchObject({
      code: "PERMISSION_REQUIRED",
      message: "Access denied: not_collaborator",
    });

    const [participant] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "private-stop-message",
      authorId: participant.id,
      content: "Stop this prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });
    const stopped = collectMessages(ws, {
      until: (message) => message.type === "processing_status",
    });
    ws.send(JSON.stringify({ type: "stop" }));
    expect((await stopped).some((message) => message.type === "processing_status")).toBe(true);
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = 'private-stop-message'"
      )
    ).toMatchObject([{ status: "failed" }]);

    for (const userId of ["user-1", crypto.randomUUID().replaceAll("-", "")]) {
      const { token: ownToken } = await issueClientWsToken(name, {
        userId,
        canonicalUserId: userId,
      });
      if (userId !== "user-1")
        await new SessionCollaboratorStore(env.DB).add(name, userId, ownerId);
      const { ws: ownSocket } = await openClientWs(name);
      sockets.push(ownSocket);
      const subscribed = collectMessages(ownSocket, {
        until: (message) => message.type === "subscribed",
      });
      ownSocket.send(JSON.stringify({ type: "subscribe", token: ownToken, clientId: userId }));
      expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
    }
    expect(
      (
        await env.DB.prepare(
          "SELECT id FROM authorization_audit_events WHERE action = 'session.private_break_glass'"
        ).all()
      ).results
    ).toHaveLength(2);
    for (const socket of sockets) socket.close();
  });

  it("keeps an invalid enforcement mode from taking down the DO and reports authorization unavailable", async () => {
    const { name, stub, team } = await scopedSession("team", "invalid");
    const userId = crypto.randomUUID().replaceAll("-", "");
    const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
    const { ws } = await openClientWs(name);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code))
    );
    ws.send(JSON.stringify({ type: "subscribe", token, clientId: "invalid-mode" }));
    await expect(closed).resolves.toBe(1011);
    expect((await stub.fetch("http://internal/internal/state")).status).toBe(200);

    await setSessionTeamsEnforcementMode(stub, "on");
    await new TeamMembershipStore(env.DB).add(team.id, userId);
    const { ws: live } = await openClientWs(name);
    const subscribed = collectMessages(live, { until: (message) => message.type === "subscribed" });
    live.send(JSON.stringify({ type: "subscribe", token, clientId: "valid-mode" }));
    expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
    await setSessionTeamsEnforcementMode(stub, "invalid");
    const unavailable = collectMessages(live, { until: (message) => message.type === "error" });
    live.send(JSON.stringify({ type: "presence", status: "active" }));
    expect((await unavailable).find((message) => message.type === "error")).toMatchObject({
      code: "AUTHORIZATION_UNAVAILABLE",
    });
    live.close();
  });
});
