import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  initNamedSession,
  openClientWs,
  collectMessages,
  seedEvents,
  queryDO,
  seedMessage,
  waitForSandboxStatus,
} from "./helpers";
import { DEFAULT_REPLAY_LIMIT } from "../../src/session/event-stream";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";

describe("Client WebSocket (via SELF.fetch)", () => {
  it("rejects a nonexistent session before initializing its Durable Object", async () => {
    const name = `ws-client-nonexistent-${Date.now()}`;

    const response = await SELF.fetch(`https://test.local/sessions/${name}/ws`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();

    const stub = env.SESSION.get(env.SESSION.idFromName(name));
    const tables = await queryDO<{ name: string }>(
      stub,
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    expect(tables).toEqual([]);
  });

  it("upgrade returns 101 with webSocket", async () => {
    const name = `ws-client-upgrade-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);
    expect(ws).not.toBeNull();
    // Clean up
    ws.close();
  });

  it("rejects a prompt sent before subscribing without enqueuing it", async () => {
    const name = `ws-client-nosub-prompt-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(
      JSON.stringify({ type: "prompt", clientRequestId: crypto.randomUUID(), content: "hello" })
    );

    // Unsubscribed sockets have no client mapping — the DO closes them
    // with 4002 and never enqueues the prompt.
    const { code } = await closed;
    expect(code).toBe(4002);

    const id = env.SESSION.idFromName(name);
    const stub = env.SESSION.get(id);
    const rows = await queryDO<{ count: number }>(stub, "SELECT COUNT(*) AS count FROM messages");
    expect(rows[0].count).toBe(0);
  });

  it("rejects typing before subscribing", async () => {
    const name = `ws-client-nosub-typing-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (event) => resolve({ code: event.code }));
    });

    ws.send(JSON.stringify({ type: "typing" }));

    await expect(closed).resolves.toEqual({ code: 4002 });
  });

  it("subscribe with valid token sends the canonical snapshot", async () => {
    const name = `ws-client-sub-${Date.now()}`;
    await initNamedSession(name, { repoOwner: "acme", repoName: "web-app" });

    const { ws, participantId, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.participantId).toBe(participantId);

    const state = subscribed.session as Record<string, unknown>;
    expect(state.id).toBe(name);
    expect(state.repoOwner).toBe("acme");

    ws.close();
  });

  it.each([
    { status: "connecting", providerObjectId: "provider-obj-123" },
    { status: "spawning", providerObjectId: "provider-obj-123" },
    { status: "spawning", providerObjectId: null },
    { status: "stale", providerObjectId: "provider-obj-123" },
    { status: "stopped", providerObjectId: "provider-obj-123" },
    { status: "failed", providerObjectId: "provider-obj-123" },
  ])(
    "subscribe hydrates dashboard URL for $status sandbox with provider object id $providerObjectId",
    async ({ status, providerObjectId }) => {
      const name = `ws-client-dashboard-url-${status}-${providerObjectId ? "with-id" : "without-id"}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env)
      // before forcing each status, otherwise it can race and overwrite the row.
      await waitForSandboxStatus(stub, "failed");
      await queryDO(
        stub,
        `UPDATE sandbox
           SET status = ?, modal_object_id = ?
         WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        status,
        providerObjectId
      );

      const { ws, messages } = await openClientWs(name, { subscribe: true });
      const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
      const state = subscribed.session as Record<string, unknown>;

      expect(state.sandboxStatus).toBe(status);
      expect(state.sandboxDashboardUrl).toBe(
        providerObjectId
          ? "https://modal.com/apps/test-workspace/main/deployed/open-inspect?activeTab=sandboxes&sandboxId=provider-obj-123"
          : null
      );

      ws.close();
    }
  );

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
    await queryDO<unknown>(
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
    expect(subscribed.artifacts).toEqual([]);
    const timeline = subscribed.timeline as {
      events: unknown[];
      hasMore: boolean;
      cursor: unknown;
    };
    expect(timeline).toBeDefined();
    expect(timeline.hasMore).toBe(false);
    expect(timeline.cursor).toBeNull();
    expect(timeline.events).toHaveLength(0);

    ws.close();
  });

  it.each([
    { eventCount: DEFAULT_REPLAY_LIMIT, expectedHasMore: false },
    { eventCount: DEFAULT_REPLAY_LIMIT + 1, expectedHasMore: true },
  ])(
    "subscribe reports hasMore=$expectedHasMore for $eventCount replay events",
    async ({ eventCount, expectedHasMore }) => {
      const name = `ws-client-replay-limit-${eventCount}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      const now = Date.now();

      await seedEvents(
        stub,
        Array.from({ length: eventCount }, (_, index) => ({
          id: `ev-${index}`,
          type: "git_sync",
          data: JSON.stringify({
            type: "git_sync",
            status: "completed",
            sandboxId: "sandbox-1",
            timestamp: now - (eventCount - index),
          }),
          createdAt: now - (eventCount - index),
        }))
      );

      const { ws, messages } = await openClientWs(name, { subscribe: true });

      const subscribed = messages!.find((message) => message.type === "subscribed") as Record<
        string,
        unknown
      >;
      const timeline = subscribed.timeline as {
        events: unknown[];
        hasMore: boolean;
      };

      expect(timeline.events).toHaveLength(DEFAULT_REPLAY_LIMIT);
      expect(timeline.hasMore).toBe(expectedHasMore);

      ws.close();
    }
  );

  it("subscribe includes historical events in batched replay", async () => {
    const name = `ws-client-replay-events-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const now = Date.now();
    await seedEvents(stub, [
      {
        id: "ev-1",
        type: "git_sync",
        data: JSON.stringify({
          type: "git_sync",
          status: "in_progress",
          sandboxId: "sandbox-1",
          timestamp: now - 2000,
        }),
        createdAt: now - 2000,
      },
      {
        id: "ev-2",
        type: "git_sync",
        data: JSON.stringify({
          type: "git_sync",
          status: "completed",
          sandboxId: "sandbox-1",
          timestamp: now - 1000,
        }),
        createdAt: now - 1000,
      },
      {
        id: "ev-3",
        type: "context_compacted",
        data: JSON.stringify({
          type: "context_compacted",
          messageId: "message-1",
          sandboxId: "sandbox-1",
          timestamp: now / 1000,
        }),
        messageId: "message-1",
        createdAt: now,
      },
    ]);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    const timeline = subscribed.timeline as {
      events: Record<string, unknown>[];
      hasMore: boolean;
    };
    expect(timeline).toBeDefined();
    expect(timeline.events).toHaveLength(3);
    expect(timeline.events[0]).toMatchObject({ eventId: "ev-1", event: { type: "git_sync" } });
    expect(timeline.events[1]).toMatchObject({ eventId: "ev-2", event: { type: "git_sync" } });
    expect(timeline.events[2]).toMatchObject({
      eventId: "ev-3",
      event: { type: "context_compacted", messageId: "message-1" },
    });

    ws.close();
  });

  it("subscribe hydrates persisted PR artifacts with parsed metadata and createdAt", async () => {
    const name = `ws-client-artifacts-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const createdAt = Date.now() - 1000;

    await queryDO(
      stub,
      "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "artifact-pr-1",
      "pr",
      "https://github.com/acme/web-app/pull/42",
      JSON.stringify({
        number: 42,
        state: "open",
        head: "feature/test",
        base: "main",
      }),
      createdAt,
      createdAt
    );

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.artifacts).toEqual([
      {
        id: "artifact-pr-1",
        type: "pr",
        url: "https://github.com/acme/web-app/pull/42",
        metadata: {
          number: 42,
          state: "open",
          head: "feature/test",
          base: "main",
        },
        createdAt,
        updatedAt: createdAt,
      },
    ]);

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

    ws.send(
      JSON.stringify({
        type: "prompt",
        clientRequestId: crypto.randomUUID(),
        content: "Hello from WS test",
      })
    );

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

  it("deduplicates a correlated prompt and restores its authoritative queue in snapshots", async () => {
    const name = `ws-client-idempotent-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws } = await openClientWs(name, { subscribe: true });
    const request = {
      type: "prompt",
      clientRequestId: crypto.randomUUID(),
      content: "Only once",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const collector = collectMessages(ws, {
        until: (message) => message.type === "prompt_queued",
        timeoutMs: 2000,
      });
      ws.send(JSON.stringify(request));
      const messages = await collector;
      expect(messages.find((message) => message.type === "prompt_queued")).toMatchObject({
        clientRequestId: request.clientRequestId,
      });
    }

    const counts = await queryDO<{ messages: number; events: number }>(
      stub,
      `SELECT (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM events WHERE type = 'user_message') AS events`
    );
    expect(counts[0]).toEqual({ messages: 1, events: 0 });

    ws.close();
    const reconnect = await openClientWs(name, { subscribe: true });
    const subscribed = reconnect.messages!.find((message) => message.type === "subscribed") as {
      promptQueue: Array<Record<string, unknown>>;
    };
    expect(subscribed.promptQueue).toEqual([
      expect.objectContaining({ content: "Only once", status: "pending" }),
    ]);
    expect(subscribed.promptQueue[0]).not.toHaveProperty("model");
    expect(subscribed.promptQueue[0]).not.toHaveProperty("reasoningEffort");
    reconnect.ws.close();
  });

  it("broadcasts prompt queue updates to every subscribed client", async () => {
    const name = `ws-client-queue-updates-${Date.now()}`;
    await initNamedSession(name);
    const first = await openClientWs(name, { subscribe: true, userId: "first-user" });
    const second = await openClientWs(name, { subscribe: true, userId: "second-user" });
    const firstMessages = collectMessages(first.ws, {
      until: (message) => message.type === "prompt_queue_updated",
      timeoutMs: 2000,
    });
    const secondMessages = collectMessages(second.ws, {
      until: (message) => message.type === "prompt_queue_updated",
      timeoutMs: 2000,
    });

    second.ws.send(
      JSON.stringify({
        type: "prompt",
        clientRequestId: crypto.randomUUID(),
        content: "Shared update",
      })
    );

    expect((await firstMessages).map((message) => message.type)).toContain("prompt_queue_updated");
    expect((await secondMessages).map((message) => message.type)).toContain("prompt_queue_updated");
    first.ws.close();
    second.ws.close();
  });

  it("rejects an idempotency conflict without creating duplicate work", async () => {
    const name = `ws-client-conflict-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws } = await openClientWs(name, { subscribe: true });
    const clientRequestId = crypto.randomUUID();
    const first = collectMessages(ws, {
      until: (message) => message.type === "prompt_queued",
      timeoutMs: 2000,
    });
    ws.send(JSON.stringify({ type: "prompt", clientRequestId, content: "First" }));
    await first;

    const conflict = collectMessages(ws, {
      until: (message) => message.type === "error",
      timeoutMs: 2000,
    });
    ws.send(JSON.stringify({ type: "prompt", clientRequestId, content: "Changed" }));
    expect((await conflict).find((message) => message.type === "error")).toMatchObject({
      code: "PROMPT_REQUEST_CONFLICT",
    });
    expect(
      (await queryDO<{ count: number }>(stub, "SELECT COUNT(*) AS count FROM messages"))[0].count
    ).toBe(1);
    ws.close();
  });

  it("enforces the unfinished queue limit before creating another message", async () => {
    const name = `ws-client-queue-full-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    for (let index = 0; index < MAX_UNFINISHED_PROMPTS; index++) {
      await seedMessage(stub, {
        id: `message-${index}`,
        authorId: participantId,
        content: `Prompt ${index}`,
        source: "web",
        status: index === 0 ? "processing" : "pending",
        createdAt: Date.now() + index,
        startedAt: index === 0 ? Date.now() : undefined,
      });
    }

    const { ws } = await openClientWs(name, { subscribe: true });
    const collector = collectMessages(ws, {
      until: (message) => message.type === "error",
      timeoutMs: 2000,
    });
    ws.send(
      JSON.stringify({
        type: "prompt",
        clientRequestId: crypto.randomUUID(),
        content: "One too many",
      })
    );
    expect((await collector).find((message) => message.type === "error")).toMatchObject({
      code: "PROMPT_QUEUE_FULL",
    });
    const [{ count }] = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM messages"
    );
    expect(count).toBe(MAX_UNFINISHED_PROMPTS);
    ws.close();
  });

  it("cancels a pending prompt, releases attachments, broadcasts, and frees its slot", async () => {
    const name = `ws-client-cancel-prompt-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    const now = Date.now();
    for (let index = 0; index < MAX_UNFINISHED_PROMPTS; index++) {
      await seedMessage(stub, {
        id: `message-${index}`,
        authorId: participantId,
        content: `Prompt ${index}`,
        source: "web",
        status: "pending",
        createdAt: now + index,
      });
    }
    await queryDO(
      stub,
      `INSERT INTO attachments
         (id, mime_type, size_bytes, object_key, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "attachment-1",
      "image/png",
      100,
      "sessions/test/attachment-1",
      "message-0",
      now
    );

    const watcher = await openClientWs(name, { subscribe: true, userId: "watcher" });
    const requester = await openClientWs(name, { subscribe: true, userId: "requester" });
    const clientRequestId = crypto.randomUUID();
    const requesterMessages = collectMessages(requester.ws, {
      until: (message) => message.type === "prompt_cancelled",
      timeoutMs: 2000,
    });
    const watcherMessages = collectMessages(watcher.ws, {
      until: (message) =>
        message.type === "prompt_queue_updated" &&
        !(message.promptQueue as Array<{ messageId: string }>).some(
          (item) => item.messageId === "message-0"
        ),
      timeoutMs: 2000,
    });

    requester.ws.send(
      JSON.stringify({ type: "cancel_prompt", messageId: "message-0", clientRequestId })
    );

    expect(
      (await requesterMessages).find((message) => message.type === "prompt_cancelled")
    ).toMatchObject({ clientRequestId, messageId: "message-0" });
    const queueUpdate = (await watcherMessages).find(
      (message) => message.type === "prompt_queue_updated"
    ) as { promptQueue: Array<{ messageId: string }> };
    expect(queueUpdate.promptQueue.map((item) => item.messageId)).not.toContain("message-0");
    expect(await queryDO(stub, "SELECT id FROM messages WHERE id = ?", "message-0")).toEqual([]);
    expect(
      await queryDO(stub, "SELECT message_id FROM attachments WHERE id = ?", "attachment-1")
    ).toEqual([{ message_id: null }]);

    const enqueueRequestId = crypto.randomUUID();
    const enqueued = collectMessages(requester.ws, {
      until: (message) => message.type === "prompt_queued",
      timeoutMs: 2000,
    });
    requester.ws.send(
      JSON.stringify({
        type: "prompt",
        clientRequestId: enqueueRequestId,
        content: "Replacement prompt",
      })
    );
    expect((await enqueued).find((message) => message.type === "prompt_queued")).toMatchObject({
      clientRequestId: enqueueRequestId,
    });

    requester.ws.close();
    watcher.ws.close();
  });

  it("returns a session to created when its first prompt is removed before execution", async () => {
    const name = `ws-client-cancel-first-prompt-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws } = await openClientWs(name, { subscribe: true });
    const enqueueRequestId = crypto.randomUUID();
    const enqueued = collectMessages(ws, {
      until: (message) => message.type === "prompt_queued",
      timeoutMs: 2000,
    });
    ws.send(
      JSON.stringify({
        type: "prompt",
        clientRequestId: enqueueRequestId,
        content: "Cancel before execution",
      })
    );
    const queued = (await enqueued).find((message) => message.type === "prompt_queued") as {
      messageId: string;
    };
    const cancelRequestId = crypto.randomUUID();
    const cancelled = collectMessages(ws, {
      until: (message) => message.type === "prompt_cancelled",
      timeoutMs: 2000,
    });

    ws.send(
      JSON.stringify({
        type: "cancel_prompt",
        messageId: queued.messageId,
        clientRequestId: cancelRequestId,
      })
    );
    await cancelled;

    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1")).toEqual([
      { status: "created" },
    ]);
    ws.close();
  });

  it("rejects cancellation when the prompt is already processing", async () => {
    const name = `ws-client-cancel-processing-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "message-processing",
      authorId: participantId,
      content: "Already running",
      source: "web",
      status: "processing",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    const { ws } = await openClientWs(name, { subscribe: true });
    const clientRequestId = crypto.randomUUID();
    const rejected = collectMessages(ws, {
      until: (message) => message.type === "error",
      timeoutMs: 2000,
    });

    ws.send(
      JSON.stringify({
        type: "cancel_prompt",
        messageId: "message-processing",
        clientRequestId,
      })
    );

    expect((await rejected).find((message) => message.type === "error")).toMatchObject({
      code: "PROMPT_NOT_CANCELLABLE",
      clientRequestId,
    });
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = ?",
        "message-processing"
      )
    ).toEqual([{ status: "processing" }]);
    ws.close();
  });

  it("does not allow web clients to cancel integration-owned prompts", async () => {
    const name = `ws-client-cancel-integration-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "message-linear",
      authorId: participantId,
      content: "Reply in Linear",
      source: "linear",
      status: "pending",
      createdAt: Date.now(),
    });
    await queryDO(
      stub,
      "UPDATE messages SET source = 'web', callback_context = ? WHERE id = ?",
      JSON.stringify({ channel: "C1", threadTs: "1.0" }),
      "message-linear"
    );
    const { ws, messages } = await openClientWs(name, { subscribe: true });
    const subscribed = messages.find((message) => message.type === "subscribed") as {
      promptQueue: Array<{ messageId: string }>;
    };
    expect(subscribed.promptQueue).toContainEqual(
      expect.objectContaining({ messageId: "message-linear" })
    );
    const clientRequestId = crypto.randomUUID();
    const rejected = collectMessages(ws, {
      until: (message) => message.type === "error",
      timeoutMs: 2000,
    });

    ws.send(
      JSON.stringify({
        type: "cancel_prompt",
        messageId: "message-linear",
        clientRequestId,
      })
    );

    expect((await rejected).find((message) => message.type === "error")).toMatchObject({
      code: "PROMPT_NOT_CANCELLABLE",
      clientRequestId,
    });
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = ?",
        "message-linear"
      )
    ).toEqual([{ status: "pending" }]);
    ws.close();
  });

  it.each([
    ["blank", "  \n"],
    ["oversized", "x".repeat(64_001)],
  ])("returns correlated INVALID_PROMPT for a %s prompt", async (_case, content) => {
    const name = `ws-client-invalid-prompt-${_case}-${Date.now()}`;
    await initNamedSession(name);
    const { ws } = await openClientWs(name, { subscribe: true });
    const clientRequestId = crypto.randomUUID();
    const collector = collectMessages(ws, {
      until: (message) => message.type === "error",
      timeoutMs: 2000,
    });

    ws.send(JSON.stringify({ type: "prompt", clientRequestId, content }));

    expect((await collector).find((message) => message.type === "error")).toMatchObject({
      type: "error",
      code: "INVALID_PROMPT",
      clientRequestId,
    });
    ws.close();
  });

  it("closing one of multiple sockets for the same participant sends presence_update, not presence_leave", async () => {
    const name = `ws-client-presence-multi-${Date.now()}`;
    await initNamedSession(name);

    // Two tabs for the same user → same participantId
    const tab1 = await openClientWs(name, { subscribe: true, userId: "user-1" });
    const tab2 = await openClientWs(name, { subscribe: true, userId: "user-1" });
    expect(tab1.participantId).toBe(tab2.participantId);

    const collector = collectMessages(tab1.ws, {
      until: (msg) => msg.type === "presence_update" || msg.type === "presence_leave",
      timeoutMs: 2000,
    });

    tab2.ws.close();

    const messages = await collector;
    expect(messages.some((m) => m.type === "presence_leave")).toBe(false);
    const update = messages.find((m) => m.type === "presence_update") as Record<string, unknown>;
    expect(update).toBeDefined();
    const participants = update.participants as Array<{ participantId: string }>;
    expect(participants.some((p) => p.participantId === tab1.participantId)).toBe(true);

    tab1.ws.close();
  });

  it("uses canonical profile IDs for bot participant subscription and presence", async () => {
    const name = `ws-client-canonical-presence-${Date.now()}`;
    await initNamedSession(name);
    const watcher = await openClientWs(name, { subscribe: true, userId: "user-1" });
    const collector = collectMessages(watcher.ws, {
      until: (msg) =>
        msg.type === "presence_update" &&
        (msg.participants as Array<{ userId: string }>).some(
          (participant) => participant.userId === "canonical-bot"
        ),
      timeoutMs: 2000,
    });

    const bot = await openClientWs(name, {
      subscribe: true,
      userId: "slack:U123",
      canonicalUserId: "canonical-bot",
    });
    const subscribed = bot.messages.find((message) => message.type === "subscribed") as {
      participant: { userId: string };
    };
    expect(subscribed.participant.userId).toBe("canonical-bot");

    const messages = await collector;
    const presence = messages.find(
      (message) =>
        message.type === "presence_update" &&
        (message.participants as Array<{ userId: string }>).some(
          (participant) => participant.userId === "canonical-bot"
        )
    ) as { participants: Array<{ userId: string }> };
    expect(presence.participants).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: "canonical-bot" })])
    );

    bot.ws.close();
    watcher.ws.close();
  });

  it("closing the only socket for a participant broadcasts presence_leave", async () => {
    const name = `ws-client-presence-leave-${Date.now()}`;
    await initNamedSession(name);

    // Two distinct users so the watcher remains connected after the target leaves
    const watcher = await openClientWs(name, { subscribe: true, userId: "user-1" });
    const leaver = await openClientWs(name, { subscribe: true, userId: "user-2" });

    const collector = collectMessages(watcher.ws, {
      until: (msg) => msg.type === "presence_leave",
      timeoutMs: 2000,
    });

    leaver.ws.close();

    const messages = await collector;
    const leave = messages.find((m) => m.type === "presence_leave") as Record<string, unknown>;
    expect(leave).toBeDefined();
    expect(leave.userId).toBe("user-2");

    watcher.ws.close();
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
