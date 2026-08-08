import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptToken } from "../../src/auth/crypto";
import { EnvironmentStore } from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  queryDO,
  seedEvents,
  waitForSandboxStatus,
} from "./helpers";

describe("session snapshot synchronization", () => {
  beforeEach(cleanD1Tables);

  it("returns a secret-free bootstrap with stable event identities", async () => {
    const name = `bootstrap-${Date.now()}`;
    const { stub } = await initNamedSession(name, { title: "Bootstrap session" });
    await waitForSandboxStatus(stub, "failed");
    const createdAt = Date.now();
    await seedEvents(stub, [
      {
        id: "stable-event-1",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: createdAt,
          messageId: "message-1",
          callId: "call-1",
          result: "ok",
        }),
        createdAt,
      },
    ]);
    await queryDO(
      stub,
      `UPDATE sandbox
       SET status = 'ready', code_server_url = ?, code_server_password = ?, ttyd_url = ?, ttyd_token = ?`,
      "https://code.example.test",
      await encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY),
      "https://terminal.example.test",
      await encryptToken("terminal-secret", env.REPO_SECRETS_ENCRYPTION_KEY)
    );

    const response = await stub.fetch("http://internal/internal/bootstrap");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const bootstrap = await response.json<Record<string, any>>();

    expect(bootstrap.sessionId).toBe(name);
    expect(bootstrap.state).toMatchObject({
      id: name,
      codeServerUrl: "https://code.example.test",
    });
    expect(bootstrap.state).not.toHaveProperty("codeServerPassword");
    expect(bootstrap.state).not.toHaveProperty("ttydToken");
    expect(JSON.stringify(bootstrap)).not.toContain("code-secret");
    expect(JSON.stringify(bootstrap)).not.toContain("terminal-secret");
    expect(bootstrap.replay.events).toContainEqual({
      eventId: "stable-event-1",
      timelineSequence: expect.any(Number),
      event: expect.objectContaining({ type: "tool_result", result: "ok" }),
    });

    const accessResponse = await stub.fetch("http://internal/internal/access");
    expect(accessResponse.status).toBe(200);
    expect(await accessResponse.json()).toEqual({
      codeServer: { url: "https://code.example.test", password: "code-secret" },
      ttyd: { url: "https://terminal.example.test", token: "terminal-secret" },
    });
  });

  it("sends one authoritative secret-free snapshot and persists only socket identity", async () => {
    const name = `snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    await queryDO(
      stub,
      "UPDATE sandbox SET code_server_password = ?, ttyd_token = ?",
      await encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY),
      await encryptToken("terminal-secret", env.REPO_SECRETS_ENCRYPTION_KEY)
    );

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    expect(messages!.map((message) => message.type)).toEqual(["subscribed"]);
    expect(messages![0].state).not.toHaveProperty("codeServerPassword");
    expect(messages![0].state).not.toHaveProperty("ttydToken");
    expect(messages![0].replay).toHaveProperty("events");
    expect(JSON.stringify(messages![0])).not.toContain("code-secret");
    expect(JSON.stringify(messages![0])).not.toContain("terminal-secret");

    const mappings = await queryDO<{ participant_id: string; client_id: string }>(
      stub,
      "SELECT participant_id, client_id FROM ws_client_mapping"
    );
    expect(mappings).toHaveLength(1);
    ws.close();
  });

  it("rejects a second subscribe on the same socket", async () => {
    const name = `snapshot-duplicate-subscribe-${Date.now()}`;
    await initNamedSession(name);
    const { ws, token } = await openClientWs(name, { subscribe: true });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token,
        clientId: "duplicate-client",
      })
    );

    await expect(closed).resolves.toEqual({ code: 4003, reason: "Already subscribed" });
  });

  it("resolves environment names before the final socket snapshot", async () => {
    const now = Date.now();
    await new EnvironmentStore(env.DB).create(
      {
        id: "env-bootstrap",
        name: "Bootstrap environment",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: now,
        updated_at: now,
      },
      []
    );
    const name = `bootstrap-environment-${now}`;
    await initNamedSession(name, { environmentId: "env-bootstrap" });

    const { ws, messages } = await openClientWs(name, { subscribe: true });
    expect(messages![0].state).toMatchObject({
      environmentId: "env-bootstrap",
      environmentName: "Bootstrap environment",
    });
    ws.close();
  });

  it("broadcasts semantic live updates and serves stable history envelopes", async () => {
    const name = `snapshot-live-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    const now = Date.now();
    await seedEvents(stub, [
      {
        id: "history-old",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: now - 1,
          messageId: "message-1",
          callId: "call-old",
          result: "old",
        }),
        createdAt: now - 1,
      },
      {
        id: "history-new",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: now,
          messageId: "message-1",
          callId: "call-new",
          result: "new",
        }),
        createdAt: now,
      },
    ]);
    const client = await openClientWs(name, { subscribe: true });

    const titlePromise = collectMessages(client.ws, {
      until: (message) => message.type === "session_title",
    });
    const updated = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "Live title" }),
    });
    expect(updated.status).toBe(200);
    expect((await titlePromise).at(-1)).toEqual({ type: "session_title", title: "Live title" });

    const pagePromise = collectMessages(client.ws, {
      until: (message) => message.type === "history_page",
    });
    client.ws.send(
      JSON.stringify({
        type: "fetch_history",
        cursor: { timestamp: now, id: "history-new" },
        limit: 10,
      })
    );
    const page = (await pagePromise).at(-1) as Record<string, any>;
    expect(page.items).toContainEqual(
      expect.objectContaining({ eventId: "history-old", timelineSequence: expect.any(Number) })
    );
    client.ws.close();
  });
});
