import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { initNamedSession, openClientWs, collectMessages, seedEvents, queryDO } from "./helpers";

describe("Client WebSocket (via SELF.fetch)", () => {
  it("upgrade returns 101 with webSocket", async () => {
    const name = `ws-client-upgrade-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);
    expect(ws).not.toBeNull();
    // Clean up
    ws.close();
  });

  it("subscribe with valid token sends subscribed + state", async () => {
    const name = `ws-client-sub-${Date.now()}`;
    await initNamedSession(name, { repoOwner: "acme", repoName: "web-app" });

    const { ws, participantId, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.sessionId).toEqual(expect.any(String));
    expect(subscribed.participantId).toBe(participantId);

    const state = subscribed.state as Record<string, unknown>;
    expect(state.repoOwner).toBe("acme");

    ws.close();
  });

  it("subscribe with invalid token closes socket 4001", async () => {
    const name = `ws-client-badtoken-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: "totally-invalid-token",
        clientId: "test-client",
      })
    );

    const { code } = await closed;
    expect(code).toBe(4001);
  });

  it("subscribe without token closes socket 4001", async () => {
    const name = `ws-client-notoken-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: "",
        clientId: "test-client",
      })
    );

    const { code } = await closed;
    expect(code).toBe(4001);
  });

  it("subscribe with expired token closes socket 4001", async () => {
    const name = `ws-client-expired-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Generate a valid WS token
    const id = env.SESSION.idFromName(name);
    const doStub = env.SESSION.get(id);
    const tokenRes = await doStub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });
    const { token } = await tokenRes.json<{ token: string }>();

    // Back-date the token past the 24-hour TTL
    const expiredAt = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await queryDO(
      stub,
      "UPDATE participants SET ws_token_created_at = ? WHERE user_id = ?",
      expiredAt,
      "user-1"
    );

    // Open WS and try to subscribe with the expired token
    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code, reason: evt.reason }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token,
        clientId: "test-client",
      })
    );

    const { code, reason } = await closed;
    expect(code).toBe(4001);
    expect(reason).toBe("Token expired");
  });

  it("subscribe includes batched replay with hasMore=false for empty session", async () => {
    const name = `ws-client-replay-empty-${Date.now()}`;
    await initNamedSession(name);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    const replay = subscribed.replay as { events: unknown[]; hasMore: boolean; cursor: unknown };
    expect(replay).toBeDefined();
    expect(replay.hasMore).toBe(false);
    expect(replay.cursor).toBeNull();
    expect(replay.events).toHaveLength(0);

    ws.close();
  });

  it("subscribe includes historical events in batched replay", async () => {
    const name = `ws-client-replay-events-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const now = Date.now();
    await seedEvents(stub, [
      {
        id: "ev-1",
        type: "tool_call",
        data: JSON.stringify({ type: "tool_call", tool: "read_file" }),
        createdAt: now - 2000,
      },
      {
        id: "ev-2",
        type: "tool_result",
        data: JSON.stringify({ type: "tool_result", result: "ok" }),
        createdAt: now - 1000,
      },
    ]);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    const replay = subscribed.replay as { events: Record<string, unknown>[]; hasMore: boolean };
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].type).toBe("tool_call");
    expect(replay.events[1].type).toBe("tool_result");

    ws.close();
  });

  it("ping gets pong response", async () => {
    const name = `ws-client-ping-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "pong",
      timeoutMs: 2000,
    });

    ws.send(JSON.stringify({ type: "ping" }));

    const messages = await collector;
    const pong = messages.find((m) => m.type === "pong");
    expect(pong).toBeDefined();
    expect(pong!.timestamp).toEqual(expect.any(Number));

    ws.close();
  });

  it("prompt via WS creates message and returns prompt_queued", async () => {
    const name = `ws-client-prompt-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const { ws } = await openClientWs(name, { subscribe: true });

    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "prompt_queued",
      timeoutMs: 2000,
    });

    ws.send(JSON.stringify({ type: "prompt", content: "Hello from WS test" }));

    const messages = await collector;
    const queued = messages.find((m) => m.type === "prompt_queued") as Record<string, unknown>;
    expect(queued).toBeDefined();
    expect(queued.messageId).toEqual(expect.any(String));

    // Verify message exists in DB
    const rows = await queryDO<{ id: string; content: string; source: string }>(
      stub,
      "SELECT id, content, source FROM messages WHERE id = ?",
      queued.messageId
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Hello from WS test");
    expect(rows[0].source).toBe("web");

    ws.close();
  });

  it("sandbox event is broadcast to subscribed client", async () => {
    const name = `ws-client-broadcast-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Subscribe a client first
    const { ws } = await openClientWs(name, { subscribe: true });

    // Listen for the broadcast
    const collector = collectMessages(ws, {
      until: (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown>)?.type === "tool_call",
      timeoutMs: 2000,
    });

    // Post sandbox event via DO internal endpoint (simulates sandbox behavior)
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tool_call",
        tool: "write_file",
        args: { path: "/src/index.ts" },
        callId: "c-broadcast",
        messageId: "msg-broadcast",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    const messages = await collector;
    const broadcast = messages.find(
      (m) =>
        m.type === "sandbox_event" && (m.event as Record<string, unknown>)?.type === "tool_call"
    );
    expect(broadcast).toBeDefined();
    expect((broadcast!.event as Record<string, unknown>).tool).toBe("write_file");

    ws.close();
  });
});
