import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import { createSessionRuntime } from "../../src/session/components";
import { cleanD1Tables } from "./cleanup";
import { componentsOf, runInSessionDO, setSessionTeamsEnforcementMode } from "./session-do-access";
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

  async function scopedSession(visibility: "workspace" | "team" | "private", mode?: string) {
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

  async function shadowAuditRows(sessionId: string) {
    const { results } = await env.DB.prepare(
      `SELECT id, request_id, principal_kind, actor_user_id_snapshot, actor_service_snapshot,
              resource_type, resource_id, team_id, reason_code, operation_result, metadata_json
       FROM authorization_audit_events WHERE action = 'session.shadow_denied' AND resource_id = ?`
    )
      .bind(sessionId)
      .all();
    return results;
  }

  async function repeatReadOnlyCommands(ws: WebSocket, stub: DurableObjectStub) {
    for (let i = 0; i < 2; i++) {
      const typing = collectMessages(ws, { until: (message) => message.type === "error" });
      ws.send(JSON.stringify({ type: "typing" }));
      expect((await typing).find((message) => message.type === "error")).toMatchObject({
        code: "PERMISSION_REQUIRED",
        message: "Access denied: not_member",
      });
      const presence = collectMessages(ws, {
        until: (message) => message.type === "presence_update",
      });
      ws.send(JSON.stringify({ type: "presence", status: "idle" }));
      expect((await presence).some((message) => message.type === "presence_update")).toBe(true);

      // Bypass only the history rate limit so every repeat reaches the fresh access check.
      await runInSessionDO(stub, (instance) => {
        for (const client of componentsOf(instance).wsManager.getAuthenticatedClients()) {
          delete client.lastFetchHistoryAtMs;
        }
      });
      const history = collectMessages(ws, { until: (message) => message.type === "history_page" });
      ws.send(JSON.stringify({ type: "fetch_history", cursor: { timestamp: 0, id: "event" } }));
      expect((await history).some((message) => message.type === "history_page")).toBe(true);
    }
  }

  it.each(["off", "shadow", "on"] as const)(
    "records only the shadow-allowed nonmember subscribe in %s mode without auditing repeated commands",
    async (mode) => {
      const { name, stub, team } = await scopedSession("team", mode);
      const canonicalUserId = crypto.randomUUID().replaceAll("-", "");
      const { token } = await issueClientWsToken(name, {
        userId: `scm-${canonicalUserId}`,
        canonicalUserId,
      });
      const { ws } = await openClientWs(name);
      const closed = vi.fn();
      ws.addEventListener("close", closed);
      try {
        if (mode === "on") {
          const revoked = new Promise<number>((resolve) =>
            ws.addEventListener("close", (event) => resolve(event.code))
          );
          ws.send(JSON.stringify({ type: "subscribe", token, clientId: "nonmember" }));
          await expect(revoked).resolves.toBe(4010);
          expect(await shadowAuditRows(name)).toEqual([]);
          return;
        }
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "nonmember" }));
        expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
        const audit = await shadowAuditRows(name);
        expect(audit).toHaveLength(mode === "shadow" ? 1 : 0);
        if (mode === "shadow") {
          expect(audit[0]).toMatchObject({
            id: expect.stringMatching(/^ws-shadow-/),
            request_id: expect.stringMatching(/^ws-/),
            principal_kind: "user",
            actor_user_id_snapshot: canonicalUserId,
            actor_service_snapshot: null,
            resource_type: "session",
            resource_id: name,
            team_id: team.id,
            reason_code: "shadow_denied:not_member",
            operation_result: "denied",
          });
          expect(JSON.parse(String(audit[0].metadata_json))).toEqual({
            before: {},
            requested: {},
            after: {},
            channel: "ws",
          });
        }
        await repeatReadOnlyCommands(ws, stub);
        expect(await shadowAuditRows(name)).toEqual(audit);
        expect(closed).not.toHaveBeenCalled();

        if (mode === "shadow") {
          const { ws: reconnected } = await openClientWs(name);
          try {
            const subscribedAgain = collectMessages(reconnected, {
              until: (message) => message.type === "subscribed",
            });
            reconnected.send(JSON.stringify({ type: "subscribe", token, clientId: "nonmember" }));
            expect((await subscribedAgain).some((message) => message.type === "subscribed")).toBe(
              true
            );
            expect(await shadowAuditRows(name)).toHaveLength(2);
          } finally {
            reconnected.close();
          }
        }
      } finally {
        ws.close();
      }
    }
  );

  it.each(["membership", "scope"] as const)(
    "observes a %s change midlease in shadow while continuing read access",
    async (change) => {
      const { name, stub, team } = await scopedSession("team", "shadow");
      const userId = `shadow-member-${crypto.randomUUID()}`;
      const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
      await new TeamMembershipStore(env.DB).add(team.id, userId);
      const { ws } = await openClientWs(name);
      const closed = vi.fn();
      ws.addEventListener("close", closed);
      try {
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "shadow-member" }));
        expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
        expect(await shadowAuditRows(name)).toEqual([]);
        let ownerTeamId = team.id;
        if (change === "membership") {
          await new TeamMembershipStore(env.DB).remove(team.id, userId);
        } else {
          const destination = await new TeamStore(env.DB).create({
            slug: `shadow-destination-${crypto.randomUUID()}`,
            name: "Shadow destination",
            joinPolicy: "invite_only",
          });
          ownerTeamId = destination.id;
          await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
            .bind(ownerTeamId, name)
            .run();
        }
        await repeatReadOnlyCommands(ws, stub);
        expect(await shadowAuditRows(name)).toMatchObject([
          {
            actor_user_id_snapshot: userId,
            team_id: ownerTeamId,
            reason_code: "shadow_denied:not_member",
          },
        ]);
        expect(closed).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    }
  );

  it("deduplicates concurrent shadow checks after runtime reconstruction using persisted socket identity", async () => {
    const { name, stub } = await scopedSession("team", "shadow");
    const userId = `shadow-restored-${crypto.randomUUID()}`;
    const { ws, messages } = await openClientWs(name, {
      subscribe: true,
      userId,
      canonicalUserId: userId,
    });
    try {
      expect(messages.some((message) => message.type === "subscribed")).toBe(true);
      const audit = await shadowAuditRows(name);
      expect(audit).toHaveLength(1);
      const presence = collectMessages(ws, {
        until: (message) => message.type === "presence_update",
      });
      await runInSessionDO(stub, async (_instance, state) => {
        const [socket] = state.getWebSockets();
        expect(state.getTags(socket)).toContain(`wsid:${audit[0].request_id}`);
        // Independent graphs have neither recovered client state nor the in-memory denial cache.
        const runtimes = [0, 1].map(() =>
          createSessionRuntime(createDurableObjectSessionPlatform(state, env.DB), {
            ...createCloudflareEnv(env),
            TEAMS_ENFORCEMENT: "shadow",
          })
        );
        for (const runtime of runtimes) {
          expect(Array.from(runtime.internals.wsManager.getAuthenticatedClients())).toEqual([]);
        }
        await Promise.all(
          runtimes.map((runtime) =>
            runtime.server.onMessage(socket, JSON.stringify({ type: "presence", status: "idle" }))
          )
        );
        for (const runtime of runtimes) {
          expect(Array.from(runtime.internals.wsManager.getAuthenticatedClients())).toMatchObject([
            { userId },
          ]);
        }
      });
      expect((await presence).some((message) => message.type === "presence_update")).toBe(true);
      expect(await shadowAuditRows(name)).toEqual(audit);
    } finally {
      ws.close();
    }
  });

  it.each(["subscribe", "command"] as const)(
    "does not change access when the real shadow audit INSERT fails at %s",
    async (phase) => {
      const { name, stub } = await scopedSession(
        phase === "subscribe" ? "team" : "workspace",
        "shadow"
      );
      const userId = `shadow-write-failure-${crypto.randomUUID()}`;
      const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
      const { ws } = await openClientWs(name);
      const closed = vi.fn();
      ws.addEventListener("close", closed);
      try {
        await env.DB.prepare(
          `CREATE TRIGGER fail_ws_shadow_audit
          BEFORE INSERT ON authorization_audit_events WHEN NEW.action = 'session.shadow_denied'
          BEGIN SELECT RAISE(ABORT, 'test shadow audit write failure'); END`
        ).run();
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "audit-failure" }));
        expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
        if (phase === "command") {
          await env.DB.prepare("UPDATE sessions SET visibility = 'team' WHERE id = ?")
            .bind(name)
            .run();
        }
        await repeatReadOnlyCommands(ws, stub);
        expect(await shadowAuditRows(name)).toEqual([]);
        expect(closed).not.toHaveBeenCalled();
      } finally {
        ws.close();
        await env.DB.prepare("DROP TRIGGER IF EXISTS fail_ws_shadow_audit").run();
      }
    }
  );

  it("rejects a still-valid token after private access is removed and refuses re-mint", async () => {
    const { name, team } = await scopedSession("private");
    const userId = crypto.randomUUID().replaceAll("-", "");
    const url = `https://test.local/sessions/${name}/ws-token`;
    const headers = await serviceRequestHeaders(url, {
      method: "POST",
      as: { userId, role: "member" },
    });
    await new TeamMembershipStore(env.DB).add(team.id, userId);
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
    "loads fresh memberships at subscribe and on team-owned commands in %s mode",
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
        expect(memberships).toHaveBeenCalledTimes(1);
        expect(collaborators).toHaveBeenCalledTimes(mode === "on" ? 1 : 0);
      } finally {
        memberships.mockRestore();
        collaborators.mockRestore();
        ws.close();
      }
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "sends visibility capabilities for a non-owner team lead in %s mode",
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

  it.each(["off", "shadow", "on"] as const)(
    "requires current membership to prompt or type in a workspace-visible team session in %s mode",
    async (mode) => {
      const { name, stub, team } = await scopedSession("workspace", mode);
      const userId = `workspace-nonmember-${crypto.randomUUID()}`;
      const { token, participantId } = await issueClientWsToken(name, {
        userId,
        canonicalUserId: userId,
      });
      await queryDO(
        stub,
        `UPDATE sandbox SET code_server_url = ?, vnc_url = ?, ttyd_url = ?,
                            tunnel_urls = ?, modal_object_id = ?`,
        "https://code.example.test",
        "https://vnc.example.test",
        "https://terminal.example.test",
        JSON.stringify({ "3000": "https://app.example.test" }),
        "team-access-sandbox"
      );
      const memberships = new TeamMembershipStore(env.DB);
      const { ws } = await openClientWs(name);
      const closed = vi.fn();
      ws.addEventListener("close", closed);
      try {
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "nonmember" }));
        const snapshot = (await subscribed).find((message) => message.type === "subscribed");
        expect(snapshot).toHaveProperty("session.capabilities", {
          canRead: true,
          canCollaborate: false,
          canManageLifecycle: false,
          canDelete: false,
          canSandbox: false,
          canManageCollaborators: false,
          canChangeVisibility: false,
        });
        for (const field of [
          "codeServerUrl",
          "sandboxDashboardUrl",
          "ttydUrl",
          "vncUrl",
          "tunnelUrls",
        ]) {
          expect(snapshot).not.toHaveProperty(`session.${field}`);
        }

        const assertDenied = async (clientRequestId: string) => {
          for (const command of [
            { type: "prompt", content: "not allowed", clientRequestId },
            { type: "typing" },
          ]) {
            const denied = collectMessages(ws, { until: (message) => message.type === "error" });
            ws.send(JSON.stringify(command));
            expect((await denied).find((message) => message.type === "error")).toMatchObject({
              code: "PERMISSION_REQUIRED",
              message: "Access denied: not_member",
            });
          }
          expect(
            await queryDO(
              stub,
              "SELECT id FROM messages WHERE client_request_id = ?",
              clientRequestId
            )
          ).toEqual([]);
          const presence = collectMessages(ws, {
            until: (message) => message.type === "presence_update",
          });
          ws.send(JSON.stringify({ type: "presence", status: "active" }));
          expect((await presence).some((message) => message.type === "presence_update")).toBe(true);
          expect(closed).not.toHaveBeenCalled();
        };

        await assertDenied("before-membership");
        await memberships.add(team.id, userId);
        await queryDO(stub, "UPDATE sandbox SET modal_object_id = NULL");

        // The test provider fails to spawn, but warming proves typing was dispatched.
        const typing = collectMessages(ws, {
          until: (message) => message.type === "sandbox_error" || message.type === "error",
        });
        ws.send(JSON.stringify({ type: "typing" }));
        const typingMessages = await typing;
        expect(typingMessages.some((message) => message.type === "sandbox_warming")).toBe(true);
        expect(typingMessages.some((message) => message.type === "error")).toBe(false);
        await waitForSandboxStatus(stub, "failed");

        const queued = collectMessages(ws, {
          until: (message) => message.type === "prompt_queued" || message.type === "error",
        });
        ws.send(
          JSON.stringify({ type: "prompt", content: "member prompt", clientRequestId: "member" })
        );
        const accepted = (await queued).find((message) => message.type === "prompt_queued");
        expect(accepted).toMatchObject({
          clientRequestId: "member",
          messageId: expect.any(String),
        });
        expect(
          await queryDO(
            stub,
            "SELECT id, author_id, content FROM messages WHERE client_request_id = ?",
            "member"
          )
        ).toEqual([
          { id: accepted?.messageId, author_id: participantId, content: "member prompt" },
        ]);

        await memberships.remove(team.id, userId);
        await assertDenied("after-membership-removal");
        expect(
          await queryDO(stub, "SELECT id FROM messages WHERE author_id = ?", participantId)
        ).toEqual([{ id: accepted?.messageId }]);
      } finally {
        ws.close();
      }
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "denies prompt and typing from a removed private team session owner in %s mode",
    async (mode) => {
      const { name, stub, team } = await scopedSession("private", mode);
      const userId = "user-1";
      const { token } = await issueClientWsToken(name, { userId, canonicalUserId: userId });
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, userId);
      const { ws } = await openClientWs(name);
      const closed = vi.fn();
      ws.addEventListener("close", closed);
      try {
        const subscribed = collectMessages(ws, {
          until: (message) => message.type === "subscribed",
        });
        ws.send(JSON.stringify({ type: "subscribe", token, clientId: "private-owner" }));
        expect((await subscribed).find((message) => message.type === "subscribed")).toMatchObject({
          session: { capabilities: { canRead: true, canCollaborate: true } },
        });

        await memberships.remove(team.id, userId);
        for (const command of [
          { type: "prompt", content: "not allowed", clientRequestId: "removed-private-owner" },
          { type: "typing" },
        ]) {
          const denied = collectMessages(ws, { until: (message) => message.type === "error" });
          ws.send(JSON.stringify(command));
          expect((await denied).find((message) => message.type === "error")).toMatchObject({
            code: "PERMISSION_REQUIRED",
            message: "Access denied: not_member",
          });
        }
        expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
        const history = collectMessages(ws, {
          until: (message) => message.type === "history_page",
        });
        ws.send(JSON.stringify({ type: "fetch_history", cursor: { timestamp: 0, id: "event" } }));
        expect((await history).some((message) => message.type === "history_page")).toBe(true);
        expect(closed).not.toHaveBeenCalled();
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

  it("closes on the next command after a D1 team scope change with enforcement on", async () => {
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
    await new TeamMembershipStore(env.DB).add(team.id, ownerId);
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
      if (userId !== "user-1") {
        await new TeamMembershipStore(env.DB).add(team.id, userId);
        await new SessionCollaboratorStore(env.DB).add(name, userId, ownerId);
      }
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
