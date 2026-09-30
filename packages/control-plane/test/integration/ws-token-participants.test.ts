import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  collectMessages,
  initNamedSession,
  initSession,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedSandboxAuth,
  serviceFetch,
  serviceRequestHeaders,
  waitForSandboxStatus,
} from "./helpers";

function wsTokenBody(body: Record<string, unknown>): string {
  return JSON.stringify({ canonicalUserId: "user-1", ...body });
}

describe("POST /internal/ws-token", () => {
  it("generates WS token for existing owner", async () => {
    const { stub } = await initSession({ userId: "user-1", scmLogin: "testuser" });

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; participantId: string }>();
    expect(body.token).toEqual(expect.any(String));
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.participantId).toEqual(expect.any(String));
  });

  it("creates new participant for unknown userId", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({
        userId: "user-new",
        canonicalUserId: "user-new",
        scmLogin: "newuser",
      }),
    });

    expect(res.status).toBe(200);

    const participants = await queryDO<{ user_id: string; role: string }>(
      stub,
      "SELECT user_id, role FROM participants ORDER BY joined_at"
    );
    expect(participants.length).toBeGreaterThanOrEqual(2);

    const newParticipant = participants.find((p) => p.user_id === "user-new");
    expect(newParticipant).toBeDefined();
    expect(newParticipant!.role).toBe("member");
  });

  it("stores token hash in participants table", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({ userId: "user-1" }),
    });

    const participants = await queryDO<{
      ws_auth_token: string | null;
      ws_token_created_at: number | null;
    }>(
      stub,
      `SELECT ws_auth_token, ws_token_created_at FROM participants WHERE user_id = 'user-1'`
    );

    expect(participants[0].ws_auth_token).not.toBeNull();
    // SHA-256 hash is 64 hex characters
    expect(participants[0].ws_auth_token!.length).toBe(64);
    expect(participants[0].ws_token_created_at).toEqual(expect.any(Number));
  });

  it("rejects ws-token without userId", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("userId is required");
  });

  it("ws-token updates SCM info on existing participant", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({
        userId: "user-1",
        scmLogin: "updated-login",
        scmName: "Updated Name",
      }),
    });

    const participants = await queryDO<{
      scm_login: string | null;
      scm_name: string | null;
    }>(stub, "SELECT scm_login, scm_name FROM participants WHERE user_id = 'user-1'");

    expect(participants[0].scm_login).toBe("updated-login");
    expect(participants[0].scm_name).toBe("Updated Name");
  });
});

describe("GET /internal/participants", () => {
  it("lists participants", async () => {
    const { stub } = await initSession({ userId: "user-1", scmLogin: "testuser" });

    // WebSocket token issuance creates runtime participant identity.
    await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wsTokenBody({ userId: "user-2", canonicalUserId: "user-2", scmLogin: "user2" }),
    });

    const res = await stub.fetch("http://internal/internal/participants");
    expect(res.status).toBe(200);

    const body = await res.json<{
      participants: Array<{
        id: string;
        userId: string;
        scmLogin: string | null;
        role: string;
      }>;
    }>();

    expect(body.participants.length).toBeGreaterThanOrEqual(2);
    const userIds = body.participants.map((p) => p.userId);
    expect(userIds).toContain("user-1");
    expect(userIds).toContain("user-2");
  });
});

describe("browser Git author attribution", () => {
  it.each(["join", "reconnect"])(
    "dispatches the linked GitHub author after an empty-body browser %s",
    async (scenario) => {
      const userId = "11111111111111111111111111111111";
      const name = `browser-author-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name, {
        userId: "linear:creator",
        canonicalUserId: userId,
      });
      const url = `https://test.local/sessions/${name}/ws-token`;
      await serviceRequestHeaders(url, { method: "POST", body: "{}" });
      await env.DB.prepare(
        "UPDATE user_identities SET provider_login = ? WHERE user_id = ? AND provider = 'github'"
      )
        .bind("octocat", userId)
        .run();
      if (scenario === "reconnect") {
        const prior = await stub.fetch("http://internal/internal/ws-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, canonicalUserId: userId }),
        });
        expect(prior.status).toBe(200);
      }
      const tokenResponse = await serviceFetch(url, { method: "POST", body: "{}" });
      expect(tokenResponse.status).toBe(200);
      const { token } = await tokenResponse.json<{ token: string }>();
      await seedSandboxAuth(stub, {
        authToken: "author-sandbox-token",
        sandboxId: "author-sandbox",
      });
      const { ws: sandbox } = await openSandboxWs(name, {
        authToken: "author-sandbox-token",
        sandboxId: "author-sandbox",
      });
      expect(sandbox).not.toBeNull();
      sandbox!.accept();
      const { ws: client } = await openClientWs(name);
      try {
        const subscribed = collectMessages(client, {
          until: (message) => message.type === "subscribed",
        });
        client.send(JSON.stringify({ type: "subscribe", token, clientId: `browser-${scenario}` }));
        expect((await subscribed).some((message) => message.type === "subscribed")).toBe(true);
        sandbox!.send(
          JSON.stringify({
            type: "ready",
            sandboxId: "author-sandbox",
            timestamp: Date.now() / 1000,
          })
        );
        await waitForSandboxStatus(stub, "ready");
        const commands = collectMessages(sandbox!, {
          until: (message) => message.type === "prompt",
        });
        client.send(
          JSON.stringify({
            type: "prompt",
            clientRequestId: crypto.randomUUID(),
            content: "Commit the fix as me",
          })
        );
        const command = (await commands).find((message) => message.type === "prompt");
        expect(command?.author).toEqual({
          userId,
          gitIdentity: {
            mode: "attributed-user",
            name: "Integration Browser User",
            email: "583231+octocat@users.noreply.github.com",
          },
        });
      } finally {
        client.close();
        sandbox!.close();
      }
    }
  );
});
