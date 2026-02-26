import { describe, it, expect } from "vitest";
import { initSession, queryDO, seedMessage } from "./helpers";

describe("POST /internal/sandbox-event", () => {
  it("stores token event", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("ok");

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = 'token'"
    );

    const tokenEvents = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.content === "hello";
    });
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("stores tool_call with messageId", async () => {
    const { stub } = await initSession();

    // Enqueue a prompt to get a real messageId
    const promptRes = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Read file", authorId: "user-1", source: "web" }),
    });
    const { messageId } = await promptRes.json<{ messageId: string }>();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/index.ts" },
        callId: "c1",
        messageId,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const events = await queryDO<{ type: string; message_id: string }>(
      stub,
      "SELECT type, message_id FROM events WHERE type = 'tool_call'"
    );

    const matching = events.filter((e) => e.message_id === messageId);
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });

  it("heartbeat updates last_heartbeat without storing event", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "running",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const sandbox = await queryDO<{ last_heartbeat: number }>(
      stub,
      "SELECT last_heartbeat FROM sandbox"
    );
    expect(sandbox[0].last_heartbeat).toEqual(expect.any(Number));

    // Heartbeats should NOT be stored as events
    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'heartbeat'"
    );
    expect(events).toHaveLength(0);
  });

  it("execution_complete marks message as completed", async () => {
    const { stub } = await initSession();

    // Get the participant ID for the owner
    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    // Seed a message in "processing" state
    const msgId = "msg-complete-test";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Test prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: msgId,
        success: true,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const messages = await queryDO<{ status: string; completed_at: number | null }>(
      stub,
      `SELECT status, completed_at FROM messages WHERE id = ?`,
      msgId
    );
    expect(messages[0].status).toBe("completed");
    expect(messages[0].completed_at).toEqual(expect.any(Number));

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("completed");
  });

  it("execution_complete with success=false marks message as failed", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-fail-test";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Failing prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: msgId,
        success: false,
        error: "Sandbox crashed",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    const messages = await queryDO<{ status: string }>(
      stub,
      `SELECT status FROM messages WHERE id = ?`,
      msgId
    );
    expect(messages[0].status).toBe("failed");

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("failed");
  });

  it("execution_complete keeps session active when queued messages remain", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const processingMsgId = "msg-processing";
    await seedMessage(stub, {
      id: processingMsgId,
      authorId: participantId,
      content: "First prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 2000,
      startedAt: Date.now() - 1000,
    });

    const queuedMsgId = "msg-queued";
    await seedMessage(stub, {
      id: queuedMsgId,
      authorId: participantId,
      content: "Second prompt",
      source: "web",
      status: "pending",
      createdAt: Date.now() - 500,
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: processingMsgId,
        success: true,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("active");
  });

  it("git_sync updates sandbox and session", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "git_sync",
        status: "completed",
        sha: "abc123def456",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const sandbox = await queryDO<{ git_sync_status: string }>(
      stub,
      "SELECT git_sync_status FROM sandbox"
    );
    expect(sandbox[0].git_sync_status).toBe("completed");

    const session = await queryDO<{ current_sha: string }>(stub, "SELECT current_sha FROM session");
    expect(session[0].current_sha).toBe("abc123def456");
  });

  it("multiple token events upsert to latest persisted event", async () => {
    const { stub } = await initSession();
    const now = Date.now() / 1000;

    // Send 3 token events for the same message
    for (let i = 0; i < 3; i++) {
      await stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "token",
          content: `token-${i}`,
          messageId: "msg-order",
          sandboxId: "sb-1",
          timestamp: now + i,
        }),
      });
    }

    const eventsRes = await stub.fetch(
      "http://internal/internal/events?type=token&message_id=msg-order"
    );
    const { events } = await eventsRes.json<{
      events: Array<{
        id: string;
        type: string;
        data: { content: string };
        messageId: string;
        createdAt: number;
      }>;
    }>();

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("token:msg-order");
    expect(events[0].messageId).toBe("msg-order");
    expect(events[0].data.content).toBe("token-2");
  });
});
