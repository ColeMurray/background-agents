import { describe, it, expect } from "vitest";
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

  it("subscribe sends replay_complete with hasMore=false for empty session", async () => {
    const name = `ws-client-replay-empty-${Date.now()}`;
    await initNamedSession(name);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const replayComplete = messages!.find((m) => m.type === "replay_complete") as Record<
      string,
      unknown
    >;
    expect(replayComplete).toBeDefined();
    expect(replayComplete.hasMore).toBe(false);
    expect(replayComplete.cursor).toBeNull();

    ws.close();
  });

  it("subscribe replays historical events before replay_complete", async () => {
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

    const types = messages!.map((m) => m.type);
    const replayIdx = types.indexOf("replay_complete");
    expect(replayIdx).toBeGreaterThan(0);

    // sandbox_event messages should appear before replay_complete
    const sandboxEvents = messages!.filter((m, i) => m.type === "sandbox_event" && i < replayIdx);
    expect(sandboxEvents.length).toBe(2);

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
