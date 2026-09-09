import { describe, it, expect } from "vitest";
import {
  collectMessages,
  initNamedSession,
  initSession,
  openSandboxWs,
  queryDO,
  seedSandboxAuth,
} from "./helpers";
import { hostContract } from "../conformance/session-core-conformance";

const SANDBOX_TOKEN = "prompt-order-sandbox-token";
const SANDBOX_ID = "prompt-order-sandbox";

describe("POST /internal/prompt", () => {
  it("enqueues prompt and returns messageId", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Fix the login bug", authorId: "user-1", source: "web" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ messageId: string; status: string }>();
    expect(body.messageId).toEqual(expect.any(String));
    expect(body.status).toBe("queued");
  });

  it("creates message row in SQLite", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Add tests", authorId: "user-1", source: "web" }),
    });

    const { messageId } = await res.json<{ messageId: string }>();
    const messages = await queryDO<{
      id: string;
      content: string;
      source: string;
      status: string;
      author_id: string;
    }>(stub, `SELECT id, content, source, status, author_id FROM messages WHERE id = ?`, messageId);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Add tests");
    expect(messages[0].source).toBe("web");
    // Status may be "pending" or "processing" depending on queue processing
    expect(["pending", "processing"]).toContain(messages[0].status);
  });

  it("persists queued prompts in FIFO order", async () => {
    const { stub } = await initSession();
    const enqueue = async (content: string) => {
      const response = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, authorId: "user-1", source: "web" }),
      });
      return (await response.json<{ messageId: string }>()).messageId;
    };

    const firstId = await enqueue("First queued prompt");
    const secondId = await enqueue("Second queued prompt");
    const queued = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC"
    );

    expect(queued.map(({ id }) => id)).toEqual([firstId, secondId]);
  });

  it("creates participant for new authorId", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello", authorId: "user-2", source: "web" }),
    });

    const participants = await queryDO<{ user_id: string; role: string }>(
      stub,
      "SELECT user_id, role FROM participants ORDER BY joined_at"
    );

    expect(participants.length).toBeGreaterThanOrEqual(2);
    const userIds = participants.map((p) => p.user_id);
    expect(userIds).toContain("user-1");
    expect(userIds).toContain("user-2");

    const owner = participants.find((p) => p.user_id === "user-1");
    expect(owner!.role).toBe("owner");
    const member = participants.find((p) => p.user_id === "user-2");
    expect(member!.role).toBe("member");
  });

  it("does not write a timeline event while a prompt is pending", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Refactor auth",
        authorId: "slack:U123",
        canonicalUserId: "canonical-bot",
        source: "slack",
      }),
    });

    const { messageId } = await res.json<{ messageId: string }>();
    const events = await queryDO<{ type: string; data: string; message_id: string }>(
      stub,
      "SELECT type, data, message_id FROM events WHERE type = 'user_message' AND message_id = ?",
      messageId
    );

    expect(events).toEqual([]);
  });

  it("orders a queued user_message after the preceding prompt completes", async () => {
    const name = `prompt-timeline-order-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const enqueue = async (content: string) => {
      const response = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, authorId: "user-1", source: "web" }),
      });
      return (await response.json<{ messageId: string }>()).messageId;
    };
    const firstPrompt = collectMessages(sandboxWs!, {
      until: (message) => message.type === "prompt",
    });
    const firstId = await enqueue("First prompt");
    await firstPrompt;
    const secondId = await enqueue("Queued follow-up");

    expect(
      await queryDO(
        stub,
        "SELECT id FROM events WHERE type = 'user_message' AND message_id = ?",
        secondId
      )
    ).toEqual([]);

    const secondPrompt = collectMessages(sandboxWs!, {
      until: (message) => message.type === "prompt" && message.messageId === secondId,
    });
    sandboxWs!.send(
      JSON.stringify({
        type: "execution_complete",
        messageId: firstId,
        success: true,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );
    await secondPrompt;

    const events = await queryDO<{ type: string; message_id: string }>(
      stub,
      `SELECT type, message_id FROM events
       WHERE message_id IN (?, ?) ORDER BY timeline_sequence`,
      firstId,
      secondId
    );
    expect(events.map((event) => [event.type, event.message_id])).toEqual([
      ["user_message", firstId],
      ["execution_complete", firstId],
      ["user_message", secondId],
    ]);
    sandboxWs!.close();
  });

  hostContract("host.concurrent-prompt-claim", async () => {
    const name = `prompt-concurrent-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const sandboxMessages = collectMessages(sandboxWs!, { timeoutMs: 500 });
    const enqueue = (content: string) =>
      stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, authorId: "user-1", source: "web" }),
      });
    const responses = await Promise.all([enqueue("Concurrent A"), enqueue("Concurrent B")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const prompts = (await sandboxMessages).filter((message) => message.type === "prompt");
    expect(prompts).toHaveLength(1);
    const rows = await queryDO<{ id: string; status: string }>(
      stub,
      `SELECT id, status FROM messages ORDER BY created_at ASC, rowid ASC`
    );
    expect(rows.map(({ status }) => status).sort()).toEqual(["pending", "processing"]);
    expect(prompts[0].messageId).toBe(rows.find(({ status }) => status === "processing")?.id);

    sandboxWs!.close();
  });

  it("stores attachments as JSON", async () => {
    const { stub } = await initSession();
    const attachmentId = "attachment-1";
    const uploadResponse = await stub.fetch("http://internal/internal/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "record",
        attachmentId,
        mimeType: "image/png",
        sizeBytes: 1024,
      }),
    });
    expect(uploadResponse.status).toBe(200);

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "See attachment",
        authorId: "user-1",
        source: "web",
        attachments: [{ name: "screenshot.png", attachmentId }],
      }),
    });

    expect(res.status).toBe(200);
    const { messageId } = await res.json<{ messageId: string }>();
    const messages = await queryDO<{ attachments: string }>(
      stub,
      `SELECT attachments FROM messages WHERE id = ?`,
      messageId
    );

    expect(messages[0].attachments).not.toBeNull();
    const parsed = JSON.parse(messages[0].attachments);
    expect(parsed).toEqual([{ name: "screenshot.png", attachmentId, mimeType: "image/png" }]);
    const attachments = await queryDO<{ message_id: string }>(
      stub,
      "SELECT message_id FROM attachments WHERE id = ?",
      attachmentId
    );
    expect(attachments).toEqual([{ message_id: messageId }]);
  });

  it("stores callback_context for Slack", async () => {
    const { stub } = await initSession();
    const callbackContext = {
      channel: "C1234",
      threadTs: "1234567890.123456",
      repoFullName: "acme/web-app",
      model: "anthropic/claude-haiku-4-5",
    };

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Deploy to staging",
        authorId: "user-1",
        source: "slack",
        callbackContext,
      }),
    });

    const { messageId } = await res.json<{ messageId: string }>();
    const messages = await queryDO<{ callback_context: string }>(
      stub,
      `SELECT callback_context FROM messages WHERE id = ?`,
      messageId
    );

    expect(messages[0].callback_context).not.toBeNull();
    const parsed = JSON.parse(messages[0].callback_context);
    expect(parsed.channel).toBe("C1234");
    expect(parsed.threadTs).toBe("1234567890.123456");
  });
});
