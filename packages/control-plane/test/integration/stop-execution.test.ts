import { describe, it, expect } from "vitest";
import {
  initSession,
  initNamedSession,
  queryDO,
  seedMessage,
  openClientWs,
  openSandboxWs,
  seedSandboxAuth,
  collectMessages,
} from "./helpers";

describe("POST /internal/stop", () => {
  it("marks processing message as failed", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-stop-1";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Test prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const res = await stub.fetch("http://internal/internal/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("stopping");

    const messages = await queryDO<{ status: string; completed_at: number | null }>(
      stub,
      "SELECT status, completed_at FROM messages WHERE id = ?",
      msgId
    );
    expect(messages[0].status).toBe("failed");
    expect(messages[0].completed_at).toEqual(expect.any(Number));
  });

  it("is idempotent with no processing message", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("stopping");
  });

  it("client receives execution_complete and processing_status false", async () => {
    const name = `ws-stop-broadcast-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Set up sandbox auth so we have a valid sandbox row
    const sandboxAuth = { authToken: "sb-tok-stop", sandboxId: "sb-stop-1" };
    await seedSandboxAuth(stub, sandboxAuth);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-stop-broadcast";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Will be stopped",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    // Subscribe a client
    const { ws } = await openClientWs(name, { subscribe: true });

    // Collect messages until we see processing_status
    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "processing_status",
      timeoutMs: 3000,
    });

    // Stop execution
    await stub.fetch("http://internal/internal/stop", { method: "POST" });

    const messages = await collector;

    // Should have a synthetic execution_complete
    const execComplete = messages.find(
      (m) =>
        m.type === "sandbox_event" &&
        (m.event as Record<string, unknown>)?.type === "execution_complete"
    );
    expect(execComplete).toBeDefined();
    const execEvent = execComplete!.event as Record<string, unknown>;
    expect(execEvent.success).toBe(false);
    expect(execEvent.messageId).toBe(msgId);

    // Should have processing_status: false
    const processingStatus = messages.find((m) => m.type === "processing_status");
    expect(processingStatus).toBeDefined();
    expect(processingStatus!.isProcessing).toBe(false);

    ws.close();
  });

  it("non-execution_complete events still broadcast normally after stop", async () => {
    const name = `ws-stop-token-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const sandboxAuth = { authToken: "sb-tok-token", sandboxId: "sb-token-1" };
    await seedSandboxAuth(stub, sandboxAuth);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-stop-then-token";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Stopped prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    // Stop first
    await stub.fetch("http://internal/internal/stop", { method: "POST" });

    // Subscribe client after stop
    const { ws } = await openClientWs(name, { subscribe: true });

    // Listen for token event
    const collector = collectMessages(ws, {
      until: (msg) =>
        msg.type === "sandbox_event" && (msg.event as Record<string, unknown>)?.type === "token",
      timeoutMs: 2000,
    });

    // Send a token event (stale, but should still broadcast)
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "token",
        content: "stale token",
        messageId: msgId,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    const messages = await collector;
    const tokenBroadcast = messages.find(
      (m) => m.type === "sandbox_event" && (m.event as Record<string, unknown>)?.type === "token"
    );
    expect(tokenBroadcast).toBeDefined();

    // Verify it's also stored in DB
    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'token' AND message_id = ?",
      msgId
    );
    expect(events.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it("execution_complete after stop drains the queue", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgA = "msg-stop-queue-a";
    const msgB = "msg-stop-queue-b";

    await seedMessage(stub, {
      id: msgA,
      authorId: participantId,
      content: "First prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 2000,
      startedAt: Date.now() - 1500,
    });

    await seedMessage(stub, {
      id: msgB,
      authorId: participantId,
      content: "Second prompt",
      source: "web",
      status: "pending",
      createdAt: Date.now() - 1000,
    });

    // Stop execution - marks message A as failed
    await stub.fetch("http://internal/internal/stop", { method: "POST" });

    // Verify A is failed
    const msgsAfterStop = await queryDO<{ id: string; status: string }>(
      stub,
      "SELECT id, status FROM messages WHERE id = ?",
      msgA
    );
    expect(msgsAfterStop[0].status).toBe("failed");

    // Bridge sends execution_complete for message A
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: msgA,
        success: false,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    // Verify A is still failed (not double-updated)
    const msgsAfterComplete = await queryDO<{ id: string; status: string }>(
      stub,
      "SELECT id, status FROM messages WHERE id = ?",
      msgA
    );
    expect(msgsAfterComplete[0].status).toBe("failed");

    // B should transition to processing (queue drained) IF sandbox is connected.
    // Without a sandbox WS, it stays pending (sandbox not connected to dispatch to).
    const msgBStatus = await queryDO<{ id: string; status: string }>(
      stub,
      "SELECT id, status FROM messages WHERE id = ?",
      msgB
    );
    // Queue drain ran but no sandbox WS, so B stays pending
    expect(msgBStatus[0].status).toBe("pending");
  });

  it("stop via WebSocket client message", async () => {
    const name = `ws-stop-client-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const sandboxAuth = { authToken: "sb-tok-ws-stop", sandboxId: "sb-ws-stop-1" };
    await seedSandboxAuth(stub, sandboxAuth);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-ws-stop";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "WS stop test",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    // Connect sandbox WS (so stop can be forwarded)
    const { ws: sandboxWs } = await openSandboxWs(name, sandboxAuth);
    if (sandboxWs) sandboxWs.accept();

    // Subscribe client
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    // Collect until we see processing_status
    const collector = collectMessages(clientWs, {
      until: (msg) => msg.type === "processing_status",
      timeoutMs: 3000,
    });

    // Client sends stop via WebSocket
    clientWs.send(JSON.stringify({ type: "stop" }));

    const messages = await collector;

    const processingStatus = messages.find((m) => m.type === "processing_status");
    expect(processingStatus).toBeDefined();
    expect(processingStatus!.isProcessing).toBe(false);

    // Verify message is failed in DB
    const dbMessages = await queryDO<{ status: string }>(
      stub,
      "SELECT status FROM messages WHERE id = ?",
      msgId
    );
    expect(dbMessages[0].status).toBe("failed");

    clientWs.close();
    if (sandboxWs) sandboxWs.close();
  });
});
