import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  openClientWs,
  queryDO,
  seedEvents,
  waitForSandboxStatus,
} from "./helpers";

describe("session snapshot synchronization", () => {
  beforeEach(cleanD1Tables);

  it("returns a secret-free snapshot with stable event identities", async () => {
    const name = `snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name, { title: "Snapshot session" });
    await waitForSandboxStatus(stub, "failed");
    const createdAt = Date.now();
    await seedEvents(stub, [
      {
        id: "stable-event-1",
        type: "git_sync",
        data: JSON.stringify({
          type: "git_sync",
          status: "completed",
          sandboxId: "sandbox-1",
          timestamp: createdAt,
        }),
        createdAt,
      },
    ]);
    await queryDO(
      stub,
      `UPDATE sandbox
       SET status = 'ready', code_server_url = ?, code_server_password = ?,
           vnc_url = ?, vnc_password = ?, ttyd_url = ?, ttyd_token = ?`,
      "https://code.example.test",
      await encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      "https://desktop.example.test",
      await encryptToken("vnc-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      "https://terminal.example.test",
      await encryptToken("terminal-secret", env.REPO_SECRETS_ENCRYPTION_KEY!)
    );

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const snapshot = await response.json<Record<string, any>>();

    expect(snapshot.session).toMatchObject({
      id: name,
      codeServerUrl: "https://code.example.test",
      vncUrl: "https://desktop.example.test",
    });
    expect(snapshot.session).not.toHaveProperty("codeServerPassword");
    expect(snapshot.session).not.toHaveProperty("vncPassword");
    expect(snapshot.session).not.toHaveProperty("ttydToken");
    expect(JSON.stringify(snapshot)).not.toContain("code-secret");
    expect(JSON.stringify(snapshot)).not.toContain("vnc-secret");
    expect(JSON.stringify(snapshot)).not.toContain("terminal-secret");
    expect(snapshot.timeline.events).toContainEqual({
      eventId: "stable-event-1",
      timelineSequence: expect.any(Number),
      event: expect.objectContaining({ type: "git_sync", status: "completed" }),
    });

    const sandboxAccessResponse = await stub.fetch("http://internal/internal/sandbox-access");
    expect(sandboxAccessResponse.status).toBe(200);
    expect(sandboxAccessResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await sandboxAccessResponse.json()).toEqual({
      codeServer: { url: "https://code.example.test", password: "code-secret" },
      vnc: { url: "https://desktop.example.test", password: "vnc-secret" },
      ttyd: { url: "https://terminal.example.test", token: "terminal-secret" },
    });

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    expect(messages!.map((message) => message.type)).toEqual(["subscribed"]);
    expect(messages![0].session).not.toHaveProperty("codeServerPassword");
    expect(messages![0].session).not.toHaveProperty("vncPassword");
    expect(messages![0].session).not.toHaveProperty("ttydToken");
    expect(messages![0].timeline).toHaveProperty("events");
    expect(JSON.stringify(messages![0])).not.toContain("code-secret");
    expect(JSON.stringify(messages![0])).not.toContain("vnc-secret");
    expect(JSON.stringify(messages![0])).not.toContain("terminal-secret");

    const mappings = await queryDO<{ participant_id: string; client_id: string }>(
      stub,
      "SELECT participant_id, client_id FROM ws_client_mapping"
    );
    expect(mappings).toHaveLength(1);
    ws.close();

    await queryDO(stub, "UPDATE sandbox SET status = 'failed'");
    const unavailableSandboxAccess = await stub.fetch("http://internal/internal/sandbox-access");
    expect(unavailableSandboxAccess.status).toBe(409);
    expect(unavailableSandboxAccess.headers.get("Cache-Control")).toBe("private, no-store");
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
});
