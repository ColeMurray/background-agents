/**
 * Unit tests for the bulk session-trace export route.
 *
 * Tests run in Node (not workerd) with mocked stores and session runtime.
 * Requests dispatch through the production module, so admission (including
 * the sessions.read permission) runs; authentication is mocked to supply the
 * principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { Env } from "../types";
import {
  MAX_MESSAGE_BYTES_PER_SESSION,
  MAX_MESSAGE_EXPORT_LIMIT,
  MAX_MESSAGE_PAGES_PER_SESSION,
  sessionExportRoutes,
} from "./session-export";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  list: vi.fn(),
  runtimeFetch: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/session-export-store", () => ({
  SessionExportStore: vi.fn().mockImplementation(function () {
    return { list: mocks.list };
  }),
}));

vi.mock("../session/runtime-client", () => ({
  createSessionRuntimeClient: vi.fn(() => ({ fetch: mocks.runtimeFetch })),
}));

vi.mock("../logger", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

const USER_PRINCIPAL: Principal = { kind: "user", userId: "user-1" };

function createEnv(permissions?: readonly PermissionId[]): Env {
  const db = permissions ? authorizationDatabase({ permissions }) : authorizationDatabase();
  return createTestEnv({
    ...TEST_SERVICE_SECRETS,
    DB: db,
  });
}

function createHandler() {
  return createTestRequestHandler([sessionExportRoutes]);
}

async function callExport(
  query: Record<string, string> = {},
  options?: { permissions?: readonly PermissionId[]; principal?: Principal }
): Promise<Response> {
  const url = new URL("https://test.local/sessions/export");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: options?.principal ?? USER_PRINCIPAL,
    request,
  }));
  return createHandler()(
    new Request(url),
    createEnv(options?.permissions),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

const sampleRow = {
  id: "session-1",
  title: "Fix the login bug",
  status: "completed",
  source: "slack",
  repoOwner: "acme",
  repoName: "web-app",
  model: "claude-sonnet-4-6",
  userId: "user-1",
  automationId: null,
  messageCount: 2,
  totalCost: 0.12,
  activeDurationMs: 45_000,
  createdAt: 1_000,
  updatedAt: 2_000,
};

function messagePage(
  messages: Record<string, unknown>[],
  hasMore: boolean,
  cursor?: string
): Response {
  return Response.json({ messages, hasMore, ...(cursor ? { cursor } : {}) });
}

/** A message record passing the runtime page schema — export fixtures need all fields. */
function sampleMessage(id: string, content: string): Record<string, unknown> {
  return {
    id,
    authorId: "user-1",
    content,
    source: "slack",
    attachments: null,
    status: "completed",
    createdAt: 1_000,
    startedAt: 1_100,
    completedAt: 1_200,
  };
}

async function readLines(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("GET /sessions/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a caller without sessions.read before touching the store", async () => {
    const response = await callExport({}, { permissions: [] });

    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  });

  it("streams one valid NDJSON session line per row with the export content type", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });

    const response = await callExport();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const lines = await readLines(response);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      type: "session",
      id: "session-1",
      title: "Fix the login bug",
      status: "completed",
      source: "slack",
      repoOwner: "acme",
      repoName: "web-app",
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(lines[0]).not.toHaveProperty("messages");
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: 100 });
  });

  it("emits a trailing cursor line when more pages remain, and parses it back", async () => {
    mocks.list.mockResolvedValue({
      sessions: [sampleRow],
      hasMore: true,
      nextCursor: { createdAt: 1_000, id: "session-1", snapshotMaxRowId: 42 },
    });

    const response = await callExport();
    const lines = await readLines(response);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      schemaVersion: 1,
      type: "cursor",
      nextCursor: "1000:session-1:42",
    });

    // The emitted cursor round-trips into the next page's keyset filter.
    mocks.list.mockResolvedValue({ sessions: [], hasMore: false, nextCursor: null });
    await callExport({ cursor: "1000:session-1:42" });
    expect(mocks.list).toHaveBeenLastCalledWith({
      cursor: { createdAt: 1_000, id: "session-1", snapshotMaxRowId: 42 },
      limit: 100,
    });
  });

  it("inlines every message page when include=messages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-1", "hello")], true, "5000"))
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-2", "done")], false));

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(1);
    expect(lines[0].messages).toEqual([
      sampleMessage("msg-1", "hello"),
      sampleMessage("msg-2", "done"),
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
    const [sessionId, path, , search] = mocks.runtimeFetch.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(path).toBe("/internal/messages");
    expect(search).toBe("?limit=100");
    expect(mocks.runtimeFetch.mock.calls[1][3]).toBe("?limit=100&cursor=5000");
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: MAX_MESSAGE_EXPORT_LIMIT });
  });

  it("preserves validated message attachment metadata", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(
      messagePage(
        [
          {
            ...sampleMessage("msg-1", "inspect this"),
            attachments: [
              { attachmentId: "attachment-1", name: "trace.png", mimeType: "image/png" },
            ],
          },
        ],
        false
      )
    );

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines[0].messages).toEqual([
      expect.objectContaining({
        attachments: [{ attachmentId: "attachment-1", name: "trace.png", mimeType: "image/png" }],
      }),
    ]);
  });

  it("rejects an invalid cursor without reading the store", async () => {
    const response = await callExport({ cursor: "not-a-cursor" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid cursor" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit without reading the store", async () => {
    const response = await callExport({ limit: "501" });

    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("applies the smaller request budget when messages are included", async () => {
    const response = await callExport({
      include: "messages",
      limit: String(MAX_MESSAGE_EXPORT_LIMIT + 1),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`limit must be at most ${MAX_MESSAGE_EXPORT_LIMIT}`);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([["createdAfter"], ["createdBefore"]])(
    "rejects an empty %s instead of coercing it to epoch zero",
    async (param) => {
      const response = await callExport({ [param]: "" });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`${param} must be a non-negative integer`);
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it("emits a session_error line and continues when a session's messages 500", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    mocks.runtimeFetch
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-ok", "fine")], false));

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      type: "session_error",
      sessionId: "session-1",
      reason: "http_error",
      status: 503,
    });
    expect(lines[0]).not.toHaveProperty("messages");
    expect(lines[1]).toMatchObject({ type: "session", id: "session-2" });
    expect(lines[1].messages).toEqual([sampleMessage("msg-ok", "fine")]);
  });

  it("emits a session_error line and continues when the runtime rejects a fetch", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    mocks.runtimeFetch
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-ok", "fine")], false));

    const response = await callExport({ include: "messages" });
    expect(response.status).toBe(200);

    const lines = await readLines(response);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      schemaVersion: 1,
      type: "session_error",
      sessionId: "session-1",
      reason: "runtime_failure",
    });
    expect(lines[1]).toMatchObject({ type: "session", id: "session-2" });
  });

  it.each([
    [
      "claims hasMore without a cursor",
      () => Response.json({ messages: [sampleMessage("msg-1", "hello")], hasMore: true }),
    ],
    [
      "drops a required message field",
      () => {
        const malformed = sampleMessage("msg-1", "hello");
        delete malformed.createdAt;
        return messagePage([malformed], false);
      },
    ],
    [
      "types hasMore as a string",
      () => Response.json({ messages: [sampleMessage("msg-1", "hello")], hasMore: "false" }),
    ],
  ])("emits only a session_error line when a page %s", async (_name, makePage) => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(makePage());

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "runtime_failure",
      },
    ]);
  });

  it("rejects a repeated runtime cursor instead of burning through the page cap", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-1", "one")], true, "same"))
      .mockResolvedValueOnce(messagePage([sampleMessage("msg-2", "two")], true, "same"));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "runtime_failure",
      },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight runtime request when the reader cancels", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let fetchSignal: AbortSignal | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    mocks.runtimeFetch.mockImplementation((_sessionId, _path, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      markFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
    });

    const response = await callExport({ include: "messages" });
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await fetchStarted;
    await reader.cancel();

    expect(fetchSignal?.aborted).toBe(true);
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not retain a session whose messages exceed the byte budget", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(
      messagePage([sampleMessage("msg-large", "x".repeat(MAX_MESSAGE_BYTES_PER_SESSION))], false)
    );

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
  });

  it("cancels a runtime response before parsing when it exceeds the byte budget", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MESSAGE_BYTES_PER_SESSION + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.runtimeFetch.mockResolvedValueOnce(new Response(body));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
    expect(cancelled).toBe(true);
  });

  it("applies the response byte budget across all message pages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const padding = "x".repeat(MAX_MESSAGE_BYTES_PER_SESSION / 2);
    mocks.runtimeFetch
      .mockResolvedValueOnce(
        Response.json({ messages: [], hasMore: true, cursor: "next", padding })
      )
      .mockResolvedValueOnce(Response.json({ messages: [], hasMore: false, padding }));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not serialize truncated messages when the page cap is reached", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let page = 0;
    mocks.runtimeFetch.mockImplementation(() =>
      Promise.resolve(messagePage([sampleMessage(`msg-${page++}`, "part")], true, String(page)))
    );

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "session_error",
      sessionId: "session-1",
      reason: "page_cap_reached",
    });
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(MAX_MESSAGE_PAGES_PER_SESSION);
  });
});
