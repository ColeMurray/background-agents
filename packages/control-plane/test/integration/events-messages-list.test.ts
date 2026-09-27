import { beforeEach, describe, it, expect } from "vitest";
import { sessionTraceExportSchema } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedEvents, seedMessage } from "./helpers";

async function seedStepUsage(
  stub: DurableObjectStub,
  rows: Array<{ id: string; createdAt: number }>
): Promise<void> {
  for (const row of rows) {
    await queryDO(
      stub,
      `INSERT INTO step_usage (id, message_id, input_tokens, total_tokens, is_subtask, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      row.id,
      "msg-usage",
      10,
      10,
      row.createdAt
    );
  }
}

describe("GET /internal/events", () => {
  beforeEach(cleanD1Tables);

  it("lists events with default pagination", async () => {
    const { stub } = await initSession();
    const baseTime = Date.now();

    await seedEvents(
      stub,
      Array.from({ length: 5 }, (_, i) => ({
        id: `evt-list-${i}`,
        type: "tool_call",
        data: JSON.stringify({ type: "tool_call", tool: "read_file", callId: `c-${i}` }),
        createdAt: baseTime + i,
      }))
    );

    const res = await stub.fetch("http://internal/internal/events?type=tool_call");
    expect(res.status).toBe(200);

    const body = await res.json<{
      events: Array<{ id: string; type: string }>;
      hasMore: boolean;
    }>();

    const seeded = body.events.filter((e) => e.id.startsWith("evt-list-"));
    expect(seeded).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });

  it("respects limit parameter", async () => {
    const { stub } = await initSession();
    const baseTime = Date.now();

    await seedEvents(
      stub,
      Array.from({ length: 10 }, (_, i) => ({
        id: `evt-lim-${i}`,
        type: "tool_result",
        data: JSON.stringify({ type: "tool_result", callId: `c-${i}`, result: "ok" }),
        createdAt: baseTime + i,
      }))
    );

    const res = await stub.fetch("http://internal/internal/events?type=tool_result&limit=3");
    expect(res.status).toBe(200);

    const body = await res.json<{
      events: Array<{ id: string }>;
      hasMore: boolean;
      cursor: string;
    }>();

    expect(body.events).toHaveLength(3);
    expect(body.hasMore).toBe(true);
    expect(body.cursor).toBeDefined();
  });

  it("cursor pagination returns next page without overlap", async () => {
    const { stub } = await initSession();
    const baseTime = Date.now();

    await seedEvents(
      stub,
      Array.from({ length: 7 }, (_, i) => ({
        id: `evt-page-${i}`,
        type: "error",
        data: JSON.stringify({ type: "error", message: `error-${i}` }),
        createdAt: baseTime + i,
      }))
    );

    // Page 1
    const res1 = await stub.fetch("http://internal/internal/events?type=error&limit=3");
    const page1 = await res1.json<{
      events: Array<{ id: string }>;
      cursor: string;
      hasMore: boolean;
    }>();
    expect(page1.events).toHaveLength(3);
    expect(page1.hasMore).toBe(true);

    // Page 2
    const res2 = await stub.fetch(
      `http://internal/internal/events?type=error&limit=3&cursor=${page1.cursor}`
    );
    const page2 = await res2.json<{
      events: Array<{ id: string }>;
      hasMore: boolean;
    }>();

    // No overlap between pages
    const page1Ids = new Set(page1.events.map((e) => e.id));
    for (const event of page2.events) {
      expect(page1Ids.has(event.id)).toBe(false);
    }
  });

  it("cursor pagination includes events tied on the page boundary timestamp", async () => {
    const { stub } = await initSession();
    const createdAt = Date.now();

    await seedEvents(
      stub,
      Array.from({ length: 5 }, (_, i) => ({
        id: `evt-tie-${i}`,
        type: "error",
        data: JSON.stringify({ type: "error", message: `error-${i}` }),
        createdAt,
      }))
    );

    const res1 = await stub.fetch("http://internal/internal/events?type=error&limit=2");
    const page1 = await res1.json<{
      events: Array<{ id: string }>;
      cursor: string;
      hasMore: boolean;
    }>();

    expect(page1.events.map((event) => event.id)).toEqual(["evt-tie-4", "evt-tie-3"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(`${createdAt}:4:evt-tie-3`);

    const res2 = await stub.fetch(
      `http://internal/internal/events?type=error&limit=2&cursor=${encodeURIComponent(page1.cursor)}`
    );
    const page2 = await res2.json<{
      events: Array<{ id: string }>;
      cursor: string;
      hasMore: boolean;
    }>();

    expect(page2.events.map((event) => event.id)).toEqual(["evt-tie-2", "evt-tie-1"]);
    expect(page2.hasMore).toBe(true);

    const res3 = await stub.fetch(
      `http://internal/internal/events?type=error&limit=2&cursor=${encodeURIComponent(page2.cursor)}`
    );
    const page3 = await res3.json<{
      events: Array<{ id: string }>;
      hasMore: boolean;
    }>();

    expect(page3.events.map((event) => event.id)).toEqual(["evt-tie-0"]);
    expect(page3.hasMore).toBe(false);
  });

  it("rejects malformed cursors", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/events?cursor=bad");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid cursor" });
  });

  it("filters events by type", async () => {
    const { stub } = await initSession();
    const baseTime = Date.now();

    await seedEvents(stub, [
      {
        id: "evt-filter-tc",
        type: "tool_call",
        data: JSON.stringify({ type: "tool_call", tool: "write_file" }),
        createdAt: baseTime,
      },
      {
        id: "evt-filter-tr",
        type: "tool_result",
        data: JSON.stringify({ type: "tool_result", callId: "c1", result: "done" }),
        createdAt: baseTime + 1,
      },
      {
        id: "evt-filter-tc2",
        type: "tool_call",
        data: JSON.stringify({ type: "tool_call", tool: "read_file" }),
        createdAt: baseTime + 2,
      },
    ]);

    const res = await stub.fetch("http://internal/internal/events?type=tool_call");
    const body = await res.json<{ events: Array<{ id: string; type: string }> }>();

    const seeded = body.events.filter((e) => e.id.startsWith("evt-filter-tc"));
    expect(seeded).toHaveLength(2);
    for (const event of seeded) {
      expect(event.type).toBe("tool_call");
    }
  });

  it("filters warning events", async () => {
    const { stub } = await initSession();
    const baseTime = Date.now();

    await seedEvents(stub, [
      {
        id: "evt-warning",
        type: "warning",
        data: JSON.stringify({ type: "warning", scope: "media", message: "Upload skipped" }),
        createdAt: baseTime,
      },
      {
        id: "evt-error",
        type: "error",
        data: JSON.stringify({ type: "error", message: "Upload failed" }),
        createdAt: baseTime + 1,
      },
    ]);

    const res = await stub.fetch("http://internal/internal/events?type=warning");
    expect(res.status).toBe(200);

    const body = await res.json<{ events: Array<{ id: string; type: string }> }>();
    expect(body.events.map((event) => event.id)).toEqual(["evt-warning"]);
    expect(body.events[0]?.type).toBe("warning");
  });

  it("strips legacy output tails from raw boot progress events", async () => {
    const { stub } = await initSession();
    await seedEvents(stub, [
      {
        id: "evt-legacy-boot-progress",
        type: "boot_progress",
        data: JSON.stringify({
          type: "boot_progress",
          bootSeq: 3,
          phase: "setup",
          status: "failed",
          detail: "setup hook failed",
          outputTail: ["legacy secret output"],
          sandboxId: "sandbox-1",
          timestamp: 123,
        }),
        createdAt: Date.now(),
      },
    ]);

    const res = await stub.fetch("http://internal/internal/events?type=boot_progress");

    expect(res.status).toBe(200);
    const body = await res.json<{ events: Array<{ id: string; data: Record<string, unknown> }> }>();
    expect(body.events).toEqual([
      expect.objectContaining({
        id: "evt-legacy-boot-progress",
        data: {
          type: "boot_progress",
          bootSeq: 3,
          phase: "setup",
          status: "failed",
          detail: "setup hook failed",
          sandboxId: "sandbox-1",
          timestamp: 123,
        },
      }),
    ]);
  });

  it("filters context compaction events", async () => {
    const { stub } = await initSession();
    const createdAt = Date.now();

    await seedEvents(stub, [
      {
        id: "evt-context-compacted",
        type: "context_compacted",
        data: JSON.stringify({
          type: "context_compacted",
          messageId: "message-1",
          sandboxId: "sandbox-1",
          timestamp: createdAt / 1000,
        }),
        messageId: "message-1",
        createdAt,
      },
      {
        id: "evt-error",
        type: "error",
        data: JSON.stringify({ type: "error", message: "failed" }),
        createdAt: createdAt + 1,
      },
    ]);

    const res = await stub.fetch("http://internal/internal/events?type=context_compacted");
    expect(res.status).toBe(200);
    const body = await res.json<{ events: Array<{ id: string; type: string }> }>();
    expect(body.events).toEqual([
      expect.objectContaining({ id: "evt-context-compacted", type: "context_compacted" }),
    ]);
  });

  it("accepts canonical event types omitted by the old manual filter catalog", async () => {
    const { stub } = await initSession();
    const res = await stub.fetch("http://internal/internal/events?type=ready");

    expect(res.status).toBe(200);
  });
});

describe("GET /internal/messages", () => {
  it("lists messages with status filter", async () => {
    const { stub } = await initSession();

    // Enqueue two prompts
    const res1 = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "First prompt", authorId: "user-1", source: "web" }),
    });
    const { messageId: msgId1 } = await res1.json<{ messageId: string }>();

    const res2 = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Second prompt", authorId: "user-1", source: "web" }),
    });
    const { messageId: msgId2 } = await res2.json<{ messageId: string }>();

    // Check that messages are listed
    const listRes = await stub.fetch("http://internal/internal/messages");
    expect(listRes.status).toBe(200);

    const body = await listRes.json<{
      messages: Array<{ id: string; content: string; status: string }>;
      hasMore: boolean;
    }>();

    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(msgId1);
    expect(ids).toContain(msgId2);
  });
});

describe("GET /internal/trace-export", () => {
  beforeEach(cleanD1Tables);

  it("returns the requested collections in the export contract, each in its export order", async () => {
    const { stub } = await initSession();
    const [owner] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    const createdAt = Date.now();
    for (const [id, offset] of [
      ["msg-1", 0],
      ["msg-2", 10],
    ] as const) {
      await seedMessage(stub, {
        id,
        authorId: owner.id,
        content: `prompt ${id}`,
        source: "web",
        status: "completed",
        createdAt: createdAt + offset,
      });
    }
    await seedEvents(stub, [
      {
        id: "tool_call:call-1",
        type: "tool_call",
        data: JSON.stringify({
          type: "tool_call",
          messageId: "msg-1",
          tool: "bash",
          args: { command: "npm test" },
          callId: "call-1",
          status: "completed",
          output: "1 passed",
        }),
        messageId: "msg-1",
        createdAt: createdAt + 1,
      },
      {
        id: "execution_complete:msg-1",
        type: "execution_complete",
        data: JSON.stringify({ type: "execution_complete", messageId: "msg-1", success: true }),
        messageId: "msg-1",
        createdAt: createdAt + 1,
      },
    ]);
    await seedStepUsage(stub, [
      { id: "step:2", createdAt: createdAt + 2 },
      { id: "step:1", createdAt: createdAt + 1 },
    ]);

    const res = await stub.fetch(
      "http://internal/internal/trace-export?include=usage,events,messages"
    );

    expect(res.status).toBe(200);
    const body = sessionTraceExportSchema.parse(await res.json());
    expect(body).toMatchObject({
      ok: true,
      trace: {
        messages: [
          { id: "msg-2", content: "prompt msg-2" },
          { id: "msg-1", content: "prompt msg-1" },
        ],
        events: [
          { id: "tool_call:call-1", type: "tool_call", data: { output: "1 passed" } },
          { id: "execution_complete:msg-1", type: "execution_complete" },
        ],
        usage: [{ id: "step:1" }, { id: "step:2" }],
      },
    });
    // The two events share a timestamp; their timeline sequence is the tie-breaker.
    const [first, second] = (body.ok && body.trace.events) || [];
    expect(first.timelineSequence).toBeLessThan(second.timelineSequence);
  });

  it("returns only the requested collections", async () => {
    const { stub } = await initSession();
    await seedStepUsage(stub, [{ id: "step:1", createdAt: Date.now() }]);

    const res = await stub.fetch("http://internal/internal/trace-export?include=usage");

    expect(res.status).toBe(200);
    expect(sessionTraceExportSchema.parse(await res.json())).toEqual({
      ok: true,
      trace: { usage: [expect.objectContaining({ id: "step:1" })] },
    });
  });

  it.each(["", "?include=prompts"])("rejects include %s", async (search) => {
    const { stub } = await initSession();

    const res = await stub.fetch(`http://internal/internal/trace-export${search}`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "include must be a comma-separated list of messages, events, usage",
    });
  });
});
