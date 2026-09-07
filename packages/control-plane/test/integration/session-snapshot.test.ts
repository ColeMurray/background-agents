import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptToken } from "../../src/auth/crypto";
import {
  sessionSnapshotSchema,
  type ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  collectMessages,
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
      tunnelUrls: null,
      sandboxDashboardUrl: null,
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

  it("shares a bounded replay across HTTP and subscription and retrieves the omitted history", async () => {
    const name = `snapshot-bounded-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    const createdAt = Date.now();
    await seedEvents(
      stub,
      Array.from({ length: 30 }, (_, i) => ({
        id: `heavy-${i}`,
        type: "token",
        messageId: "active-message",
        createdAt,
        data: JSON.stringify({
          type: "token",
          content: "x".repeat(32768),
          messageId: "active-message",
          sandboxId: "sandbox-1",
          timestamp: createdAt,
        }),
      }))
    );
    await queryDO(
      stub,
      `INSERT INTO messages(id,author_id,content,source,status,created_at)
      SELECT 'active-message',id,'Active prompt','web','processing',? FROM participants LIMIT 1`,
      createdAt
    );
    const response = await stub.fetch("http://internal/internal/snapshot");
    const snapshot = sessionSnapshotSchema.parse(await response.json());
    expect(snapshot.timeline.events.length).toBeLessThan(10);
    expect(snapshot.timeline.hasMore).toBe(true);
    expect(snapshot.promptQueue).toContainEqual({
      messageId: "active-message",
      content: "Active prompt",
      status: "processing",
    });
    const { ws, messages } = await openClientWs(name, { subscribe: true });
    try {
      expect(messages![0].timeline).toEqual(snapshot.timeline);
      expect(messages![0].promptQueue).toEqual(snapshot.promptQueue);
      const ids = snapshot.timeline.events.map((row) => row.eventId);
      let { cursor, hasMore } = snapshot.timeline;
      while (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 210));
        const pending = collectMessages(ws, {
          until: (message) => message.type === "history_page",
        });
        ws.send(JSON.stringify({ type: "fetch_history", cursor, limit: 200 }));
        const replies = await pending;
        const page = replies.find((message) => message.type === "history_page") as
          | Extract<ServerMessage, { type: "history_page" }>
          | undefined;
        expect(page).toBeDefined();
        expect(page!.items.length).toBeGreaterThan(0);
        expect(page!.items.length).toBeLessThan(10);
        ids.unshift(...page!.items.map((row) => row.eventId));
        cursor = page!.cursor;
        hasMore = page!.hasMore;
      }
      expect(ids.filter((id) => id.startsWith("heavy-"))).toEqual(
        Array.from({ length: 30 }, (_, i) => `heavy-${i}`)
      );
    } finally {
      ws.close();
    }
  });
});
