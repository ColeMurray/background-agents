import { describe, it, expect } from "vitest";
import { initSession, queryDO } from "./helpers";

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

  it("writes user_message event", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Refactor auth", authorId: "user-1", source: "web" }),
    });

    const { messageId } = await res.json<{ messageId: string }>();
    const events = await queryDO<{ type: string; data: string; message_id: string }>(
      stub,
      "SELECT type, data, message_id FROM events WHERE type = 'user_message'"
    );

    const matching = events.filter((e) => e.message_id === messageId);
    expect(matching.length).toBeGreaterThanOrEqual(1);

    const data = JSON.parse(matching[0].data);
    expect(data.content).toBe("Refactor auth");
    expect(data.messageId).toBe(messageId);
    expect(data.author).toBeDefined();
  });

  it("stores attachments as JSON", async () => {
    const { stub } = await initSession();
    const attachments = [
      { type: "file", name: "screenshot.png", url: "https://example.com/img.png" },
    ];

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "See attachment",
        authorId: "user-1",
        source: "web",
        attachments,
      }),
    });

    const { messageId } = await res.json<{ messageId: string }>();
    const messages = await queryDO<{ attachments: string }>(
      stub,
      `SELECT attachments FROM messages WHERE id = ?`,
      messageId
    );

    expect(messages[0].attachments).not.toBeNull();
    const parsed = JSON.parse(messages[0].attachments);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("screenshot.png");
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
